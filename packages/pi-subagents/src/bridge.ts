import type { SubagentStatus } from "./status.js";

/**
 * Superpi subagent bridge.
 *
 * The extension owns the child sessions, so it is the only place that can see a
 * child's live events. This module projects that in-process knowledge onto a
 * versioned, serializable record and emits it on a single cross-extension bus
 * channel. The future Paseo companion subscribes to the channel; Paseo and Pi
 * core are never modified, and the root Pi process is never driven through the
 * child SDK.
 *
 * Deliberate boundaries:
 * - The bridge is observation-only. It never steers, resumes, queues, or aborts
 *   a run; the existing `Agent` / `get_subagent_result` / `steer_subagent` tools
 *   remain the only control surface.
 * - Records are best-effort projections of live events, not a second durable
 *   transcript. The child transcript JSONL and `result.md` stay authoritative.
 * - Streaming activity (`message_update`, `tool_execution_update`) is projected
 *   too, preserving the native assistant message event (including its live
 *   `partial`), usage, and tool partial results. Every record is bounded by
 *   `MAX_BRIDGE_RECORD_BYTES`: a finalized string is preserved in full up to
 *   that cap, and an oversized record becomes an explicit omission marker that
 *   keeps identity and `transcriptPath` so the native transcript stays the
 *   recovery path and observers can report the gap (R4.8).
 */

/** Bus channel for every bridge record. */
export const SUPERPI_SUBAGENT_BRIDGE_CHANNEL = "superpi:subagent:v1";

/** Schema version carried by every record. */
export const SUPERPI_SUBAGENT_BRIDGE_VERSION = 1 as const;

export type SuperpiSubagentBridgeType = "created" | "activity" | "terminal";

/**
 * Host-facing outcome vocabulary. It deliberately differs from the internal
 * `SubagentStatus`: `error` is `failed`, and `stopped`/`aborted` are `canceled`.
 * The internal run and follow-up tool details keep their own status; `reason`
 * carries the richer detail (timeout, turn limit, provider error).
 */
export type SuperpiSubagentBridgeOutcome =
	| "completed"
	| "steered"
	| "canceled"
	| "failed";

/**
 * One versioned bridge record.
 *
 * Identities are intentionally distinct: `runId` is the extension's stable run
 * id, `toolCallId` is the spawning Pi tool invocation, and `childSessionId` is
 * the child Pi session. `parentRunId` is present for nested grandchildren.
 */
export interface SuperpiSubagentBridgeRecord {
	version: 1;
	runId: string;
	sequence: number;
	type: SuperpiSubagentBridgeType;
	parentRunId?: string;
	parentSessionId?: string;
	childSessionId?: string;
	toolCallId?: string;
	title?: string;
	timestamp?: number;
	transcriptPath?: string;
	/** Actual child working directory, when the extension knows it. */
	cwd?: string;
	/** Activity payload for `type: "activity"`. */
	record?: unknown;
	outcome?: SuperpiSubagentBridgeOutcome;
	result?: unknown;
	reason?: string;
	/** Set when the payload exceeded the per-record cap; see `omittedBytes`. */
	omitted?: boolean;
	omittedBytes?: number;
}

export type SuperpiSubagentActivityKind =
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "turn_start"
	| "turn_end";

/** Bounded, serializable projection of one live child session event. */
export interface SuperpiSubagentActivityRecord {
	kind: SuperpiSubagentActivityKind;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	parentToolCallId?: string;
	message?: unknown;
	assistantMessageEvent?: unknown;
	usage?: unknown;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
}

/** Internal status → host outcome. */
export function bridgeOutcomeFor(
	status: SubagentStatus,
): SuperpiSubagentBridgeOutcome {
	switch (status) {
		case "error":
			return "failed";
		case "stopped":
		case "aborted":
			return "canceled";
		case "steered":
			return "steered";
		default:
			return "completed";
	}
}

const MAX_BRIDGE_DEPTH = 8;

/**
 * Per-record ceiling with room for notification escaping in an eight MiB RPC
 * frame. Finalized strings are preserved in full up to this bound;
 * beyond it the record keeps its identity and `transcriptPath` and is marked
 * `omitted`, so the omission is explicit rather than a silent truncation.
 */
export const MAX_BRIDGE_RECORD_BYTES = 3 * 1024 * 1024;

/** Ceiling for a retained oversized terminal result, mirroring journal retention. */
const MAX_BRIDGE_RETAINED_RESULT_BYTES = 64 * 1024;

function byteLength(value: string): number {
	return Buffer.byteLength(value);
}

/**
 * Deep-copy a value into a JSON-serializable projection. Cycles become
 * `[circular]`; over-deep structures become `[truncated]`; bigints become
 * strings; functions and symbols are dropped. Strings are preserved in full;
 * `createRunBridge` bounds the whole record instead of clipping individual
 * fields, so a finalized message is never silently shortened. The result never
 * contains a live object reference, so consumers can persist, log, or forward it
 * without the child session leaking through.
 */
export function toBridgeValue(
	value: unknown,
	depth = 0,
	ancestors: WeakSet<object> = new WeakSet(),
): unknown {
	if (value === null || value === undefined) return value ?? null;
	const kind = typeof value;
	if (kind === "string") return value;
	if (kind === "number" || kind === "boolean") return value;
	if (kind === "bigint") return (value as bigint).toString();
	if (kind !== "object") return undefined;
	if (depth >= MAX_BRIDGE_DEPTH) return "[truncated]";

	const object = value as object;
	if (ancestors.has(object)) return "[circular]";
	ancestors.add(object);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => toBridgeValue(entry, depth + 1, ancestors));
		}
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const projected = toBridgeValue(entry, depth + 1, ancestors);
			if (projected !== undefined) output[key] = projected;
		}
		return output;
	} finally {
		ancestors.delete(object);
	}
}

function readString(
	source: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Project one live child session event. Returns `undefined` for events outside
 * the documented bridge vocabulary.
 */
export function projectActivity(
	event: unknown,
): SuperpiSubagentActivityRecord | undefined {
	if (!event || typeof event !== "object") return undefined;
	const source = event as Record<string, unknown>;
	const type = source.type;
	switch (type) {
		case "message_start":
		case "message_end":
			return {
				kind: type,
				message: toBridgeValue(source.message),
			};
		case "message_update":
			return {
				kind: type,
				message: toBridgeValue(source.message),
				assistantMessageEvent: toBridgeValue(source.assistantMessageEvent),
				usage: toBridgeValue(source.usage),
			};
		case "tool_execution_start":
			return {
				kind: type,
				toolCallId: readString(source, "toolCallId"),
				toolName: readString(source, "toolName"),
				parentToolCallId: readString(source, "parentToolCallId"),
				args: toBridgeValue(source.args),
			};
		case "tool_execution_update":
			return {
				kind: type,
				toolCallId: readString(source, "toolCallId"),
				toolName: readString(source, "toolName"),
				parentToolCallId: readString(source, "parentToolCallId"),
				args: toBridgeValue(source.args),
				partialResult: toBridgeValue(source.partialResult),
			};
		case "tool_execution_end":
			return {
				kind: type,
				toolCallId: readString(source, "toolCallId"),
				toolName: readString(source, "toolName"),
				parentToolCallId: readString(source, "parentToolCallId"),
				isError: source.isError === true,
				result: toBridgeValue(source.result),
			};
		case "turn_start":
			return { kind: "turn_start" };
		case "turn_end":
			return {
				kind: "turn_end",
				message: toBridgeValue(source.message),
				result: toBridgeValue(source.toolResults),
			};
		default:
			return undefined;
	}
}

export interface SuperpiSubagentBridgeIdentifiers {
	runId: string;
	parentRunId?: string;
	parentSessionId?: string;
	childSessionId?: string;
	toolCallId?: string;
	title?: string;
	transcriptPath?: string;
	cwd?: string;
}

export type SuperpiSubagentBridgeSink = (
	record: SuperpiSubagentBridgeRecord,
) => void;

export interface RunBridge {
	/** Emit the one initial record. Ignored after the terminal record. */
	created(extra?: { timestamp?: number }): void;
	/** Emit one activity record. Returns whether the event was bridged. */
	activity(event: unknown): boolean;
	/** Emit the terminal record exactly once. Later calls are ignored. */
	terminal(terminal: {
		outcome: SuperpiSubagentBridgeOutcome;
		result?: unknown;
		reason?: string;
		timestamp?: number;
	}): void;
	readonly terminalEmitted: boolean;
}

function baseFields(
	ids: SuperpiSubagentBridgeIdentifiers,
): Pick<
	SuperpiSubagentBridgeRecord,
	| "parentRunId"
	| "parentSessionId"
	| "childSessionId"
	| "toolCallId"
	| "title"
	| "transcriptPath"
	| "cwd"
> {
	return {
		parentRunId: ids.parentRunId,
		parentSessionId: ids.parentSessionId,
		childSessionId: ids.childSessionId,
		toolCallId: ids.toolCallId,
		title: ids.title,
		transcriptPath: ids.transcriptPath,
		cwd: ids.cwd,
	};
}

function boundedResult(value: unknown): unknown {
	if (value === undefined) return null;
	let text: string;
	try {
		const json = JSON.stringify(value);
		text = json === undefined ? String(value) : json;
	} catch {
		text = String(value);
	}
	if (byteLength(text) <= MAX_BRIDGE_RETAINED_RESULT_BYTES) return value;
	return `${text.slice(0, MAX_BRIDGE_RETAINED_RESULT_BYTES)}\n…[result truncated; ${byteLength(text)} bytes total]`;
}

/**
 * Replace an oversized record with an explicit omission marker. Identity and
 * `transcriptPath` (the native transcript reference) survive, and a terminal
 * record keeps its outcome, reason, and a bounded result so the run's ending is
 * never lost even when the payload cannot be forwarded.
 */
function omitRecord(
	record: SuperpiSubagentBridgeRecord,
	omittedBytes: number,
): SuperpiSubagentBridgeRecord {
	const omitted: SuperpiSubagentBridgeRecord = {
		version: record.version,
		runId: record.runId,
		sequence: record.sequence,
		type: record.type,
		omitted: true,
		omittedBytes,
	};
	if (record.parentRunId !== undefined)
		omitted.parentRunId = record.parentRunId;
	if (record.parentSessionId !== undefined)
		omitted.parentSessionId = record.parentSessionId;
	if (record.childSessionId !== undefined)
		omitted.childSessionId = record.childSessionId;
	if (record.toolCallId !== undefined) omitted.toolCallId = record.toolCallId;
	if (record.title !== undefined) omitted.title = record.title;
	if (record.timestamp !== undefined) omitted.timestamp = record.timestamp;
	if (record.transcriptPath !== undefined)
		omitted.transcriptPath = record.transcriptPath;
	if (record.cwd !== undefined) omitted.cwd = record.cwd;
	if (record.type === "terminal") {
		if (record.outcome !== undefined) omitted.outcome = record.outcome;
		if (record.reason !== undefined) omitted.reason = record.reason;
		omitted.result = boundedResult(record.result);
	}
	return omitted;
}

/** Bound one record to `MAX_BRIDGE_RECORD_BYTES`, omitting the payload if needed. */
function boundRecord(
	record: SuperpiSubagentBridgeRecord,
): SuperpiSubagentBridgeRecord {
	let bytes: number;
	try {
		bytes = byteLength(JSON.stringify(record));
	} catch {
		return omitRecord(record, 0);
	}
	return bytes <= MAX_BRIDGE_RECORD_BYTES ? record : omitRecord(record, bytes);
}

/**
 * Per-run bridge state. `sequence` is monotonic and starts at 1 so consumers can
 * detect gaps and reorder. The terminal record is sticky: once emitted, later
 * activity or terminal calls are dropped, so a late result collection can never
 * reopen a finished child (R4.6).
 */
export function createRunBridge(
	sink: SuperpiSubagentBridgeSink,
	ids: SuperpiSubagentBridgeIdentifiers,
): RunBridge {
	let sequence = 0;
	let terminalEmitted = false;

	function emit(
		type: SuperpiSubagentBridgeType,
		fields: Partial<SuperpiSubagentBridgeRecord>,
	): void {
		sink(
			boundRecord({
				version: SUPERPI_SUBAGENT_BRIDGE_VERSION,
				runId: ids.runId,
				sequence: ++sequence,
				type,
				...baseFields(ids),
				...fields,
			}),
		);
	}

	return {
		created(extra) {
			if (terminalEmitted) return;
			emit("created", { timestamp: extra?.timestamp ?? Date.now() });
		},
		activity(event) {
			if (terminalEmitted) return false;
			const record = projectActivity(event);
			if (!record) return false;
			emit("activity", { timestamp: Date.now(), record });
			return true;
		},
		terminal(terminal) {
			if (terminalEmitted) return;
			terminalEmitted = true;
			emit("terminal", {
				timestamp: terminal.timestamp ?? Date.now(),
				outcome: terminal.outcome,
				result: toBridgeValue(terminal.result),
				reason: terminal.reason,
			});
		},
		get terminalEmitted() {
			return terminalEmitted;
		},
	};
}
