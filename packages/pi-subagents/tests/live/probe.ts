import { appendFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Live-harness probe extension.
 *
 * Loaded in every session (parent and child) via the isolated agent dir's
 * `extensions/` directory. It does two things:
 *
 * 1. Records each session's active tool set to `PI_LIVE_PROBE_FILE` (one JSON
 *    line per phase), so the harness can verify the frozen tool policy without
 *    relying on the model to report its own toolset.
 * 2. Forwards `pi.events` lifecycle signals as RPC `extension_ui_request`
 *    notifications prefixed with `PROBE`.
 */

const CHANNELS = [
	"subagents:created",
	"subagents:started",
	"subagents:completed",
	"subagents:failed",
	"subagents:steered",
	"subagents:child:session-created",
	"subagents:child:disposed",
];

export default function probe(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;

	const record = (phase: string) => {
		const file = process.env.PI_LIVE_PROBE_FILE;
		if (!file) return;
		try {
			appendFileSync(
				file,
				`${JSON.stringify({
					phase,
					sessionId: ctx?.sessionManager.getSessionId(),
					tools: pi.getActiveTools(),
				})}\n`,
			);
		} catch {
			// Best-effort observation channel.
		}
	};

	pi.on("session_start", (_event, c) => {
		ctx = c;
		record("session_start");
		ctx.ui.notify(
			`PROBE active-tools: ${pi.getActiveTools().join(",")}`,
			"info",
		);
	});
	pi.on("before_agent_start", () => {
		record("before_agent_start");
	});
	// The provider payload is what the model actually sees; hidden declarations are
	// applied to it at request time.
	pi.on("before_provider_request", (event) => {
		const file = process.env.PI_LIVE_PROBE_FILE;
		if (!file) return;
		try {
			const payload = event.payload as
				| { tools?: Array<{ name?: string; function?: { name?: string } }> }
				| undefined;
			const tools = (payload?.tools ?? [])
				.map((tool) => tool.name ?? tool.function?.name)
				.filter((name): name is string => typeof name === "string");
			appendFileSync(
				file,
				`${JSON.stringify({
					phase: "provider_request",
					sessionId: ctx?.sessionManager.getSessionId(),
					tools,
				})}\n`,
			);
		} catch {
			// Best-effort observation channel.
		}
	});
	for (const channel of CHANNELS) {
		pi.events.on(channel, (data) => {
			ctx?.ui.notify(`PROBE ${channel} ${JSON.stringify(data)}`, "info");
		});
	}
}
