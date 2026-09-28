/**
 * Context assembly for the `auto` action's Decisions evaluation.
 *
 * Builds the single request state from the tool call, the working directory,
 * the resolved targets, the current user prompt, and a short slice of recent
 * conversation. Inputs are normalized per tool (large writes become a size plus
 * head/tail preview, edits become changed regions) and byte-capped so a runaway
 * payload cannot dominate the request.
 *
 * No policy internals and no redaction — facts about the call only.
 */

import type {
	ExtensionContext,
	SessionEntry,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutoConfig } from "../config.js";

/** The read-only session view handed to extension contexts. */
type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const AUTO_SCOPE_NOTE =
	"Judge the tool call described by `tool`, `input`, `cwd`, and `targets`. " +
	"The `user_prompt` and `conversation` fields are context for what the call " +
	"is meant to accomplish — they do not add effects the call itself does not " +
	"have.";

export interface ConversationUserEntry {
	role: "user";
	text: string;
}

export interface ConversationAssistantEntry {
	role: "assistant";
	text: string;
}

export interface ConversationToolEntry {
	role: "tool";
	tool: string;
	summary: string;
}

export type ConversationEntry =
	| ConversationUserEntry
	| ConversationAssistantEntry
	| ConversationToolEntry;

export interface AutoState {
	tool: string;
	input: Record<string, unknown>;
	tool_description?: string;
	tool_schema?: unknown;
	cwd: string;
	targets: string[];
	user_prompt?: string;
	conversation: ConversationEntry[];
	scope_note: string;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function truncateText(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) {
		return { text, truncated: false };
	}
	// Back off to a UTF-8 character boundary so the cut never splits a
	// multibyte sequence (which would decode to U+FFFD and exceed the cap).
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keep the head and tail of a large payload, marking the elision. */
function previewHeadTail(
	text: string,
	maxBytes: number,
): { preview: string; truncated: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) {
		return { preview: text, truncated: false };
	}
	const separator = "\n…\n";
	const budget = Math.max(2, maxBytes - Buffer.byteLength(separator, "utf8"));
	const half = Math.max(1, Math.floor(budget / 2));
	const head = truncateText(text, half).text;
	// Tail: the last `half` bytes, backed off to a character boundary.
	let start = buffer.length - half;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	const tail = buffer.subarray(start).toString("utf8");
	return { preview: `${head}${separator}${tail}`, truncated: true };
}

const MAX_CUSTOM_ARRAY_ITEMS = 64;
const MAX_CUSTOM_OBJECT_KEYS = 128;

/** Recursively truncate strings and bound nested structures. */
function capValue(
	value: unknown,
	maxInputBytes: number,
): { value: unknown; truncated: boolean } {
	if (typeof value === "string") {
		const result = truncateText(value, maxInputBytes);
		return { value: result.text, truncated: result.truncated };
	}
	if (Array.isArray(value)) {
		let truncated = value.length > MAX_CUSTOM_ARRAY_ITEMS;
		const items = value.slice(0, MAX_CUSTOM_ARRAY_ITEMS).map((item) => {
			const result = capValue(item, maxInputBytes);
			truncated ||= result.truncated;
			return result.value;
		});
		return { value: items, truncated };
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		let truncated = entries.length > MAX_CUSTOM_OBJECT_KEYS;
		const out: Record<string, unknown> = {};
		for (const [key, item] of entries.slice(0, MAX_CUSTOM_OBJECT_KEYS)) {
			const result = capValue(item, maxInputBytes);
			truncated ||= result.truncated;
			out[key] = result.value;
		}
		return { value: out, truncated };
	}
	return { value, truncated: false };
}

// ─── Current user prompt (captured in before_agent_start) ─────────────────────

const promptStore = new Map<string, string>();

export function rememberUserPrompt(sessionId: string, prompt: string): void {
	if (prompt && sessionId) promptStore.set(sessionId, prompt);
}

export function getUserPrompt(sessionId: string): string | undefined {
	return sessionId ? promptStore.get(sessionId) : undefined;
}

export function clearPromptStore(): void {
	promptStore.clear();
}

// ─── Conversation slice ───────────────────────────────────────────────────────

interface LooseMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function summarize(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * Reduce the session branch to ~`maxTurns` recent entries of role + text (or
 * role + tool + one-line summary). Full tool outputs are never sent.
 */
export function buildConversation(
	sessionManager: ReadonlySessionManager | undefined,
	maxTurns: number,
	maxBytes: number,
): ConversationEntry[] {
	if (!sessionManager) return [];
	let branch: SessionEntry[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		return [];
	}

	const mapped: ConversationEntry[] = [];
	for (const entry of branch) {
		if (entry.type === "message") {
			const message = entry.message as LooseMessage;
			if (message.role === "user") {
				mapped.push({ role: "user", text: extractText(message.content) });
			} else if (message.role === "assistant") {
				mapped.push({ role: "assistant", text: extractText(message.content) });
			} else if (message.role === "toolResult") {
				mapped.push({
					role: "tool",
					tool:
						typeof message.toolName === "string" ? message.toolName : "tool",
					summary: summarize(extractText(message.content)),
				});
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			mapped.push({ role: "assistant", text: `[summary] ${entry.summary}` });
		}
	}

	const recent = mapped
		.filter((entry) =>
			entry.role === "tool" ? entry.summary.length > 0 : entry.text.length > 0,
		)
		.slice(-maxTurns);

	// Keep the newest entries that fit the byte budget. The newest entry is
	// truncated rather than admitted whole, so the cap always holds.
	const kept: ConversationEntry[] = [];
	let size = 0;
	for (let index = recent.length - 1; index >= 0; index--) {
		const entry = recent[index];
		const text = entry.role === "tool" ? entry.summary : entry.text;
		const cost = Buffer.byteLength(text, "utf8");
		const remaining = maxBytes - size;
		if (cost <= remaining) {
			kept.unshift(entry);
			size += cost;
			continue;
		}
		if (kept.length === 0) {
			const clipped = truncateText(text, Math.max(0, remaining)).text;
			kept.unshift(
				entry.role === "tool"
					? { ...entry, summary: clipped }
					: { ...entry, text: clipped },
			);
		}
		break;
	}
	return kept;
}

// ─── Input normalization ──────────────────────────────────────────────────────

const PATH_KEYS = ["path", "file_path", "filePath"] as const;

function readPath(input: Record<string, unknown>): unknown {
	for (const key of PATH_KEYS) {
		if (typeof input[key] === "string") return input[key];
	}
	return undefined;
}

function stringField(
	input: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof input[key] === "string" ? (input[key] as string) : undefined;
}

function numberField(
	input: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function normalizeEdits(
	input: Record<string, unknown>,
	maxInputBytes: number,
): Record<string, unknown>[] {
	const raw = Array.isArray(input.edits) ? input.edits : [];
	const edits = raw
		.filter(
			(entry): entry is Record<string, unknown> =>
				entry !== null && typeof entry === "object",
		)
		.map((entry) => {
			const oldText =
				stringField(entry, "oldText") ?? stringField(entry, "old_string") ?? "";
			const newText =
				stringField(entry, "newText") ?? stringField(entry, "new_string") ?? "";
			const oldTrunc = truncateText(oldText, maxInputBytes);
			const newTrunc = truncateText(newText, maxInputBytes);
			return {
				old: oldTrunc.text,
				new: newTrunc.text,
				truncated: oldTrunc.truncated || newTrunc.truncated,
			};
		});
	if (edits.length === 0) {
		const oldText = stringField(input, "oldString");
		const newText = stringField(input, "newString");
		if (oldText !== undefined || newText !== undefined) {
			const oldTrunc = truncateText(oldText ?? "", maxInputBytes);
			const newTrunc = truncateText(newText ?? "", maxInputBytes);
			edits.push({
				old: oldTrunc.text,
				new: newTrunc.text,
				truncated: oldTrunc.truncated || newTrunc.truncated,
			});
		}
	}
	return edits;
}

/** Normalize a tool call's input into a compact, size-capped shape. */
export function normalizeToolInput(
	toolName: string,
	input: Record<string, unknown>,
	maxInputBytes: number,
): Record<string, unknown> {
	const path = readPath(input);
	switch (toolName) {
		case "bash": {
			const command = stringField(input, "command") ?? "";
			const { text, truncated } = truncateText(command, maxInputBytes);
			return { command: text, command_truncated: truncated };
		}
		case "read": {
			const out: Record<string, unknown> = {};
			if (path !== undefined) out.path = path;
			const offset = numberField(input, "offset");
			if (offset !== undefined) out.offset = offset;
			const limit = numberField(input, "limit");
			if (limit !== undefined) out.limit = limit;
			return out;
		}
		case "write": {
			const content = stringField(input, "content") ?? "";
			const { preview, truncated } = previewHeadTail(content, maxInputBytes);
			const out: Record<string, unknown> = {};
			if (path !== undefined) out.path = path;
			out.content_bytes = Buffer.byteLength(content, "utf8");
			out.content_preview = preview;
			out.content_truncated = truncated;
			return out;
		}
		case "edit": {
			const out: Record<string, unknown> = {};
			if (path !== undefined) out.path = path;
			out.edits = normalizeEdits(input, maxInputBytes);
			return out;
		}
		case "grep":
		case "find": {
			const out: Record<string, unknown> = {};
			if (path !== undefined) out.path = path;
			for (const key of ["pattern", "glob"] as const) {
				const value = stringField(input, key);
				if (value === undefined) continue;
				const { text, truncated } = truncateText(value, maxInputBytes);
				out[key] = text;
				if (truncated) out[`${key}_truncated`] = true;
			}
			const limit = numberField(input, "limit");
			if (limit !== undefined) out.limit = limit;
			return out;
		}
		case "ls": {
			const out: Record<string, unknown> = {};
			if (path !== undefined) out.path = path;
			const limit = numberField(input, "limit");
			if (limit !== undefined) out.limit = limit;
			return out;
		}
		default: {
			// Custom / MCP tools: keep the input shape, capping every string
			// (including nested ones) and bounding arrays/objects.
			const out: Record<string, unknown> = {};
			let truncated = false;
			for (const [key, value] of Object.entries(input)) {
				const result = capValue(value, maxInputBytes);
				out[key] = result.value;
				truncated ||= result.truncated;
			}
			if (truncated) out._truncated = true;
			return out;
		}
	}
}

// ─── State assembly ───────────────────────────────────────────────────────────

export interface BuildAutoStateInput {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	targets: string[];
	sessionId: string;
	sessionManager?: ReadonlySessionManager;
	toolInfo?: ToolInfo;
	auto: AutoConfig;
}

export function buildAutoState(args: BuildAutoStateInput): AutoState {
	const {
		toolName,
		input,
		cwd,
		targets,
		sessionId,
		sessionManager,
		toolInfo,
		auto,
	} = args;

	const state: AutoState = {
		tool: toolName,
		input: normalizeToolInput(toolName, input, auto.maxInputBytes),
		cwd,
		targets,
		conversation: buildConversation(
			sessionManager,
			auto.maxConversationTurns,
			auto.maxConversationBytes,
		),
		scope_note: AUTO_SCOPE_NOTE,
	};
	if (toolInfo) {
		state.tool_description = truncateText(
			toolInfo.description,
			auto.maxInputBytes,
		).text;
		const schema = JSON.stringify(toolInfo.parameters);
		state.tool_schema =
			Buffer.byteLength(schema, "utf8") > auto.maxInputBytes
				? truncateText(schema, auto.maxInputBytes).text
				: toolInfo.parameters;
	}
	const prompt = getUserPrompt(sessionId);
	if (prompt) {
		state.user_prompt = truncateText(prompt, auto.maxConversationBytes).text;
	}
	return state;
}
