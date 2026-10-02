/**
 * Embedding context view (REQUIREMENTS R7.9).
 *
 * Exact port of the experiment's `text_for(..., "context")` over a
 * `_scrub_recorded_state`'d state: one `<role>: <text>` line per message plus
 * ` [tool <name>]` per call, joined with `\n`, keeping the last 20,000
 * characters (code points, like the experiment's slice).
 *
 * The state passed in already has scrubbed text/args; scrubbing again is a
 * no-op for those and covers tool names, which the state keeps verbatim.
 */

import { scrubSecrets } from "../scrub.js";
import type { BoundedState } from "./bounded.js";

export const CONTEXT_VIEW_CHARS = 20000;

/** Last `maxChars` Unicode code points (mirrors the experiment's `[-n:]`). */
function takeLastChars(text: string, maxChars: number): string {
	const points = Array.from(text);
	return points.length <= maxChars ? text : points.slice(-maxChars).join("");
}

export function contextView(
	state: BoundedState,
	maxChars: number = CONTEXT_VIEW_CHARS,
): string {
	const lines = state.conversation.map((message) => {
		let body = scrubSecrets(message.text ?? "");
		for (const call of message.tool_calls ?? []) {
			// Mirrors the experiment's f-string: a missing name renders as None.
			const name =
				call.name === null || call.name === undefined
					? "None"
					: scrubSecrets(call.name);
			body += ` [tool ${name}]`;
		}
		return `${message.role}: ${body}`;
	});
	return takeLastChars(lines.join("\n"), maxChars);
}
