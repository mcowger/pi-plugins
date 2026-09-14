import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createConfigLoader } from "./config.js";
import { handleToolCall, pendingNudges } from "./hooks/tool-call.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initBashParser } from "./utils/bash-ast.js";
import { logStartup } from "./utils/logger.js";
import { matchRule } from "./utils/matching.js";

export type ControlsMode = "enforce" | "ignore" | "inform";

const MODES: ControlsMode[] = ["enforce", "ignore", "inform"];

const MODE_DESCRIPTIONS: Record<ControlsMode, string> = {
	enforce: "enforce — block tool calls that violate policy (default)",
	ignore: "ignore  — disable pi-controls entirely (no evaluation, no output)",
	inform: "inform  — show what would be blocked, but allow everything",
};

const MODE_NOTIFY_TYPE: Record<ControlsMode, "info" | "warning" | "error"> = {
	enforce: "info",
	ignore: "warning",
	inform: "info",
};

export default async function piControls(pi: ExtensionAPI): Promise<void> {
	const loader = createConfigLoader();
	let mode: ControlsMode = "enforce";

	function setWidgetForMode(ctx: {
		ui: { setWidget: (id: string, lines: string[]) => void };
	}): void {
		if (mode === "ignore") {
			ctx.ui.setWidget("pi-controls-mode", ["[pi-controls: IGNORE]"]);
		} else if (mode === "inform") {
			ctx.ui.setWidget("pi-controls-mode", ["[pi-controls: INFORM]"]);
		} else {
			// enforce is the default — no widget clutter
			ctx.ui.setWidget("pi-controls-mode", []);
		}
	}

	// Load config early so we can read cycleKey before registering the shortcut.
	// session_start will reload it again (picking up any runtime changes).
	await loader.load();
	const cycleKey = loader.getConfig().cycleKey;

	// biome-ignore lint/suspicious/noExplicitAny: KeyId is a wide string union; cast avoids importing pi-tui directly
	pi.registerShortcut(cycleKey as any, {
		description: "Cycle pi-controls mode: enforce → ignore → inform",
		handler: (ctx) => {
			const currentIndex = MODES.indexOf(mode);
			mode = MODES[(currentIndex + 1) % MODES.length];
			setWidgetForMode(ctx);
			ctx.ui.notify(
				`[pi-controls] Mode set to: ${mode}`,
				MODE_NOTIFY_TYPE[mode],
			);
		},
	});

	async function handleControlsCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const arg = args.trim().toLowerCase() as ControlsMode;
		if (MODES.includes(arg)) {
			mode = arg;
			setWidgetForMode(ctx);
			ctx.ui.notify(
				`[pi-controls] Mode set to: ${mode}`,
				MODE_NOTIFY_TYPE[mode],
			);
			return;
		}

		// No valid mode argument — show a select popup.
		const choice = await ctx.ui.select(
			"[pi-controls] Select mode",
			MODES.map((m) => `${m} — ${MODE_DESCRIPTIONS[m]}`),
		);
		if (!choice) return;
		// Parse the mode from the choice label (e.g. "enforce — enforce ...").
		const selected = choice.split(" — ")[0] as ControlsMode;
		mode = selected;
		setWidgetForMode(ctx);
		ctx.ui.notify(`[pi-controls] Mode set to: ${mode}`, MODE_NOTIFY_TYPE[mode]);
	}

	const completionProvider = (prefix: string): AutocompleteItem[] => {
		return MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
			value: m,
			label: m,
			description: MODE_DESCRIPTIONS[m],
		}));
	};

	pi.registerCommand("controls", {
		description: "Set pi-controls mode: enforce | ignore | inform",
		getArgumentCompletions: completionProvider,
		handler: handleControlsCommand,
	});

	pi.registerCommand("pi-control", {
		description: "Set pi-controls mode: enforce | ignore | inform",
		getArgumentCompletions: completionProvider,
		handler: handleControlsCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		await initBashParser((msg) => {
			ctx.ui.notify(msg, "warning");
			logStartup(`bash-parser warning: ${msg}`);
		});

		// Restore widget state if mode was changed before a reload.
		setWidgetForMode(ctx);

		try {
			await loader.load();
			const config = loader.getConfig();
			const policyCount = Object.keys(config.policies).length;
			const locationCount = Object.keys(config.locations).length;
			await logStartup(
				`loaded: ${policyCount} policies, ${locationCount} locations, defaultPolicy=${config.defaultPolicy ?? "null"}`,
			);
			if (policyCount === 0 && locationCount === 0) {
				ctx.ui.notify(
					`[pi-controls] No config found — all tool calls are unrestricted. Create ${getAgentDir()}/extensions/pi-controls.jsonc to enforce policies.`,
					"warning",
				);
			}
		} catch (err) {
			const msg = `failed to load config: ${err}`;
			ctx.ui.notify(`[pi-controls] ${msg}`, "error");
			await logStartup(msg);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (mode === "ignore") return;
		const config = loader.getConfig();

		// Collect the set of active policies (those referenced by any
		// location entry or used as the defaultPolicy).
		const activePolicyNames = new Set(Object.values(config.locations));
		if (config.defaultPolicy) {
			activePolicyNames.add(config.defaultPolicy);
		}

		if (activePolicyNames.size === 0) return;

		// Build the list: active policies that exist in config.
		const activePolicies = [...activePolicyNames]
			.filter((name) => name in config.policies)
			.map((name) => config.policies[name]);

		if (activePolicies.length === 0) return;

		// A tool is "universally denied" if every active policy returns
		// "deny" for that tool (no rule overrides to allow).
		const activeTools = pi.getActiveTools();
		const deniedTools = activeTools.filter((toolName) =>
			activePolicies.every(
				(policy) => matchRule(policy, toolName, null) === "deny",
			),
		);

		if (deniedTools.length > 0) {
			const kept = activeTools.filter((t) => !deniedTools.includes(t));
			pi.setActiveTools(kept);
			ctx.ui.notify(
				`[pi-controls] Hiding ${deniedTools.length} universally-denied ${deniedTools.length === 1 ? "tool" : "tools"}: ${deniedTools.join(", ")}`,
				"info",
			);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "ignore") return undefined;
		const config = loader.getConfig();
		return handleToolCall(event, ctx, config, mode);
	});

	pi.on("tool_result", async (event, _ctx) => {
		const nudgeMessage = pendingNudges.get(event.toolCallId);
		if (!nudgeMessage) return undefined;
		pendingNudges.delete(event.toolCallId);

		// Append the nudge reminder to the tool result content so the LLM sees it.
		const existing = event.content ?? [];
		return {
			content: [
				{
					type: "text" as const,
					text: `[pi-controls nudge] ${nudgeMessage}\n\n`,
				},
				...existing,
			],
		};
	});
}
