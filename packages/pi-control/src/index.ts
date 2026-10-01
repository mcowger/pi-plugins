import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { createConfigLoader } from "./config.js";
import { handleToolCall, pendingNudges } from "./hooks/tool-call.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initBashParser } from "./utils/bash-ast.js";
import { ForwardingManager } from "./utils/forwarding.js";
import { logStartup } from "./utils/logger.js";
import { universallyDeniedTools } from "./utils/tool-hiding.js";
import {
	getSubagentSessionRegistry,
	subscribeSubagentLifecycle,
} from "./utils/subagent.js";
import { clearPromptStore, rememberUserPrompt } from "./utils/auto-state.js";
import { clearAutoCache } from "./utils/auto-decisions.js";
import {
	AUTO_ENTRY_TYPE,
	type AutoTranscriptEntry,
	type AutoVerdictInfo,
	toAutoTranscriptEntry,
} from "./utils/auto-transcript.js";

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

	// Forwarded `ask` prompts: register every in-process subagent child the
	// moment its spawner announces it, and serve this session's inbox while it
	// has a UI to answer with.
	const forwardingManager = new ForwardingManager();
	const unsubscribeSubagentLifecycle = subscribeSubagentLifecycle(
		pi.events,
		getSubagentSessionRegistry(),
	);
	/** Best-effort tool metadata (description + schema) for auto context. */
	const toolInfo = (name: string) =>
		pi.getAllTools().find((tool) => tool.name === name);

	// Live auto evaluations are surfaced as durable custom entries: visible in
	// the transcript, never sent to the model (see utils/auto-transcript.ts).
	const appendAutoVerdict = (info: AutoVerdictInfo): void => {
		pi.appendEntry<AutoTranscriptEntry>(
			AUTO_ENTRY_TYPE,
			toAutoTranscriptEntry(info),
		);
	};

	pi.registerEntryRenderer<AutoTranscriptEntry>(
		AUTO_ENTRY_TYPE,
		(entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data) {
				return new Text(theme.fg("dim", "[pi-controls auto] (no data)"), 0, 0);
			}
			const color = data.verdict === "deny" ? "error" : "success";
			const target = data.command ?? data.tool;
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(
				new Text(
					`${theme.fg("accent", "[pi-controls auto]")} ${theme.fg(color, data.verdict)} ${target}`,
					0,
					0,
				),
			);
			box.addChild(new Text(theme.fg("dim", data.explanation), 0, 0));
			if (expanded && data.targets.length > 0) {
				box.addChild(
					new Text(
						theme.fg("dim", `targets: ${data.targets.join(", ")}`),
						0,
						0,
					),
				);
			}
			return box;
		},
	);

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

		// Config may have changed; cached verdicts and the captured prompt are
		// session-scoped state that must not survive a reload.
		clearAutoCache();
		clearPromptStore();

		// Restore widget state if mode was changed before a reload.
		setWidgetForMode(ctx);

		// Start draining this session's forwarded-ask inbox when it has a UI.
		forwardingManager.start(ctx);

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

	pi.on("before_agent_start", async (event, ctx) => {
		// Re-arm forwarding against the live context before any tool call.
		forwardingManager.start(ctx);
		rememberUserPrompt(ctx.sessionManager.getSessionId(), event.prompt);
		if (mode === "ignore") return;
		const config = loader.getConfig();

		const activeTools = pi.getActiveTools();
		const deniedTools = universallyDeniedTools(activeTools, config);

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
		return handleToolCall(
			event,
			ctx,
			config,
			mode,
			toolInfo,
			appendAutoVerdict,
		);
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

	pi.on("session_shutdown", () => {
		forwardingManager.stop();
		unsubscribeSubagentLifecycle();
	});
}
