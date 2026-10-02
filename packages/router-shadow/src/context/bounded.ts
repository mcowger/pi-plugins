/**
 * Bounded classification state (REQUIREMENTS R6.3).
 *
 * Exact port of the experiment's `build_bounded_state`: last 8 messages,
 * 6000-unit budget checked before each message, each text scrubbed then
 * truncated to 800 UTF-16 units, tool args scrubbed then truncated to 200.
 * Tool names pass through verbatim here (the experiment scrubs them at the
 * context-view boundary instead) so `state_hash` stays comparable.
 */

import { scrubSecrets } from "../scrub.js";
import { truncateUtf16 } from "./utf16.js";
import type { Msg } from "./entries.js";

export const MAX_CONTEXT_MESSAGES = 8;
export const MAX_MESSAGE_CHARS = 800;
export const MAX_CONTEXT_CHARS = 6000;
export const TOOL_ARG_CHARS = 200;

export type ApiType = "responses" | "messages" | "chat" | "unknown";

const API_TYPE_MAP: Record<string, ApiType> = {
	"openai-responses": "responses",
	"anthropic-messages": "messages",
	"openai-completions": "chat",
};

export interface BoundedToolCall {
	name: string | null;
	arguments: string;
}

export interface BoundedMessage {
	role: string;
	text: string;
	tool_calls?: BoundedToolCall[];
	name?: string;
}

export interface BoundedState {
	task: "classify_request";
	conversation: BoundedMessage[];
	structural: {
		message_count: number;
		has_tools: false;
		tool_count: 0;
		has_images: boolean;
		api_type: ApiType;
	};
}

/** Latest assistant `api` wins, over ALL messages (not just the last 8). */
function apiTypeOf(messages: Msg[]): ApiType {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.api) {
			return API_TYPE_MAP[message.api] ?? "unknown";
		}
	}
	return "unknown";
}

/** Pure function: messages → bounded Plexus `buildClassificationContext` state. */
export function buildBoundedState(messages: Msg[]): BoundedState {
	const conversation: BoundedMessage[] = [];
	let total = 0;
	for (const message of messages.slice(-MAX_CONTEXT_MESSAGES)) {
		if (total >= MAX_CONTEXT_CHARS) break;
		const text = truncateUtf16(
			scrubSecrets(message.text ?? ""),
			MAX_MESSAGE_CHARS,
		);
		total += text.length;
		const entry: BoundedMessage = { role: message.role || "user", text };
		if (message.tool_calls && message.tool_calls.length > 0) {
			entry.tool_calls = message.tool_calls.map((call) => ({
				name: call.name,
				arguments: truncateUtf16(
					scrubSecrets(call.arguments ?? ""),
					TOOL_ARG_CHARS,
				),
			}));
		}
		if (message.role === "tool" && message.name) {
			entry.name = message.name;
		}
		conversation.push(entry);
	}
	return {
		task: "classify_request",
		conversation,
		structural: {
			message_count: messages.length,
			has_tools: false,
			tool_count: 0,
			has_images: messages.some((message) => message.has_image),
			api_type: apiTypeOf(messages),
		},
	};
}
