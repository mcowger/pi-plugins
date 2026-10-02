/**
 * Session entries → messages (REQUIREMENTS R6.1, R6.2).
 *
 * Exact port of the experiment's `reconstruct_ancestry` message conversion
 * plus the R6.2 current-prompt rule. Input types are structural (not the pi
 * SDK types) so this stays pure and fixture-testable; the live handler adapts
 * SDK entries at the call site.
 */

import { collapseWhitespace } from "./utf16.js";

export type MsgRole = "user" | "assistant" | "tool" | "system";

export interface ToolCallRecord {
	name: string | null;
	/** Canonical JSON (sorted keys, no spaces) or the original string. */
	arguments: string;
}

export interface Msg {
	role: MsgRole;
	text: string;
	tool_calls: ToolCallRecord[] | null;
	/** Tool name for role "tool". */
	name: string | null;
	has_image: boolean;
	/** Provider API of the source message (e.g. "openai-responses"). */
	api: string | null;
}

/** Minimal structural view of a session entry. Unknown fields are ignored. */
export interface EntryLike {
	type: string;
	id: string;
	parentId: string | null;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		api?: string;
	};
	summary?: string;
	customType?: string;
	content?: unknown;
	firstKeptEntryId?: string;
}

const ROLE_MAP: Record<string, MsgRole> = {
	user: "user",
	system: "system",
	developer: "system",
	assistant: "assistant",
	toolResult: "tool",
	bashExecution: "user",
	pythonExecution: "user",
	fileMention: "user",
	hookMessage: "user",
};

/** Custom message types that are pure UI activity, never classified. */
const PURE_UI_CUSTOM_TYPES = new Set(["wj-pi-subagents-activity"]);

/** Join text parts with "\n", exactly like the experiment's `content_text`. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/** True if any content part is an image, like `content_has_image`. */
export function contentHasImage(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			part !== null &&
			typeof part === "object" &&
			((part as { type?: unknown }).type === "image" ||
				(part as { type?: unknown }).type === "image_url"),
	);
}

/**
 * Canonical tool-argument string: keep strings as-is, serialize anything else
 * to JSON with sorted keys and no spaces (mirrors `_tool_args_string`).
 */
export function toolArgsString(args: unknown): string {
	if (typeof args === "string") return args;
	if (args === null || args === undefined) return "";
	try {
		return canonicalJson(args) as string;
	} catch {
		return String(args);
	}
}

/** Recursive key-sorted JSON with `,`/`:` separators and no spaces. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new TypeError("unserializable value");
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		);
	return `{${entries.join(",")}}`;
}

function convertMessageEntry(entry: NonNullable<EntryLike["message"]>): Msg {
	const persistedRole =
		typeof entry.role === "string" && entry.role ? entry.role : "user";
	const msg: Msg = {
		role: ROLE_MAP[persistedRole] ?? "user",
		text: contentText(entry.content),
		tool_calls: null,
		name: null,
		has_image: contentHasImage(entry.content),
		api: typeof entry.api === "string" ? entry.api : null,
	};
	if (persistedRole === "assistant" && Array.isArray(entry.content)) {
		const calls: ToolCallRecord[] = [];
		for (const part of entry.content) {
			if (
				part !== null &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "toolCall"
			) {
				const call = part as { name?: unknown; arguments?: unknown };
				calls.push({
					name: typeof call.name === "string" ? call.name : null,
					arguments: toolArgsString(call.arguments),
				});
			}
		}
		if (calls.length > 0) msg.tool_calls = calls;
	}
	if (persistedRole === "toolResult") {
		msg.name = typeof entry.toolName === "string" ? entry.toolName : null;
	}
	return msg;
}

/**
 * Walk the active branch from the current leaf (last entry) to the root via
 * `parentId`, then map to messages. Uses the latest compaction boundary when
 * present; `branch_summary` becomes a user message, other `custom_message`
 * entries become system messages.
 *
 * The current prompt must be the last message (R6.2): when the branch doesn't
 * yet contain it, append `{role: "user", text: prompt}`; when the last branch
 * message is already a user message with equal collapsed text, don't append.
 * The `hasImages` flag marks the last message either way.
 */
export function entriesToMessages(
	branch: EntryLike[],
	prompt: string,
	hasImages: boolean,
): Msg[] {
	const leaf = branch.length > 0 ? branch[branch.length - 1] : undefined;
	return messagesFromEntry(branch, leaf?.id, prompt, hasImages);
}

/**
 * Like `entriesToMessages`, but walks from `entryId` instead of the branch
 * leaf — mirroring the experiment, which reconstructs from the turn's user
 * entry. Falls back to the leaf when `entryId` is null/unknown.
 */
export function messagesFromEntry(
	branch: EntryLike[],
	entryId: string | null | undefined,
	prompt: string,
	hasImages: boolean,
): Msg[] {
	const byId = new Map<string, EntryLike>();
	for (const entry of branch) {
		if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
	}

	const chain: EntryLike[] = [];
	const seen = new Set<string>();
	let compaction: EntryLike | null = null;
	let stopId: string | null = null;

	let current: EntryLike | undefined =
		(typeof entryId === "string" ? byId.get(entryId) : undefined) ??
		(branch.length > 0 ? branch[branch.length - 1] : undefined);
	while (current) {
		const id = current.id;
		if (typeof id === "string") {
			if (seen.has(id)) break; // parent cycle: stop, mirroring the experiment
			seen.add(id);
		}
		if (current.type === "compaction" && compaction === null) {
			compaction = current;
			stopId =
				typeof current.firstKeptEntryId === "string"
					? current.firstKeptEntryId
					: null;
		} else if (current.type === "message") {
			chain.push(current);
		} else if (current.type === "branch_summary") {
			chain.push(current);
		} else if (
			current.type === "custom_message" &&
			!PURE_UI_CUSTOM_TYPES.has(current.customType ?? "")
		) {
			chain.push(current);
		}
		if (stopId !== null && id === stopId) break;
		const parentId = current.parentId;
		current = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}
	chain.reverse();

	const messages: Msg[] = [];
	for (const node of chain) {
		if (node.type === "message") {
			messages.push(convertMessageEntry(node.message ?? {}));
		} else if (node.type === "branch_summary") {
			messages.push({
				role: "user",
				text: typeof node.summary === "string" ? node.summary : "",
				tool_calls: null,
				name: null,
				has_image: false,
				api: null,
			});
		} else {
			// custom_message → system message with the content text
			const content = node.content;
			messages.push({
				role: "system",
				text: typeof content === "string" ? content : contentText(content),
				tool_calls: null,
				name: null,
				has_image:
					typeof content === "string" ? false : contentHasImage(content),
				api: null,
			});
		}
	}

	if (compaction !== null) {
		messages.unshift({
			role: "user",
			text: typeof compaction.summary === "string" ? compaction.summary : "",
			tool_calls: null,
			name: null,
			has_image: false,
			api: null,
		});
	}

	const last = messages[messages.length - 1];
	if (
		last &&
		last.role === "user" &&
		collapseWhitespace(last.text) === collapseWhitespace(prompt)
	) {
		if (hasImages) last.has_image = true;
	} else {
		messages.push({
			role: "user",
			text: prompt,
			tool_calls: null,
			name: null,
			has_image: hasImages,
			api: null,
		});
	}
	return messages;
}
