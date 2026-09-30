import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Live-harness probe extension.
 *
 * Loaded alongside the subagent extension under test so the harness sees the
 * cross-extension lifecycle events (`pi.events`) that are otherwise invisible in
 * the RPC stream. It forwards each one as an RPC `extension_ui_request` notify
 * prefixed with `PROBE`, which the driver records and the comparator reads.
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
	pi.on("session_start", (_event, c) => {
		ctx = c;
		ctx.ui.notify(
			`PROBE active-tools: ${pi.getActiveTools().join(",")}`,
			"info",
		);
	});
	for (const channel of CHANNELS) {
		pi.events.on(channel, (data) => {
			ctx?.ui.notify(`PROBE ${channel} ${JSON.stringify(data)}`, "info");
		});
	}
}
