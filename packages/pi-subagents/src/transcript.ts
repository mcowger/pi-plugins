import type { SubagentRun } from "./run.js";
import type { SubagentStatus } from "./status.js";

const OUTPUT_FILE_PREFIX = "Output file:";

/**
 * Render the unadorned result-content line the Paseo reader matches with
 * `/^Output file:\s*(\S+)$/m`. The path must contain no whitespace, quotes, or
 * markdown.
 */
export function outputFileLine(path: string): string {
	if (!path.trim()) throw new Error("transcript path is empty");
	if (/\s/.test(path))
		throw new Error(`transcript path contains whitespace: ${path}`);
	return `${OUTPUT_FILE_PREFIX} ${path}`;
}

/** Whether a path is safe to advertise to the Paseo reader. */
export function isWireSafePath(path: string): boolean {
	return path.length > 0 && !/\s/.test(path);
}

// ---------------------------------------------------------------------------
// Formatting helpers, matching @tintinweb/pi-subagents byte for byte.
// ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(
	startedAt: number,
	completedAt?: number,
): string {
	if (completedAt) return formatMs(completedAt - startedAt);
	return `${formatMs(Date.now() - startedAt)} (running)`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
	return `${count} token`;
}

export function formatTurns(
	turnCount: number,
	maxTurns?: number | null,
): string {
	return maxTurns != null ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Human-readable status label used inside the `<task-notification>` XML. */
export function statusLabel(status: SubagentStatus, error?: string): string {
	switch (status) {
		case "error":
			return `Error: ${error ?? "unknown"}`;
		case "aborted":
			return "Aborted (max turns exceeded)";
		case "steered":
			return "Wrapped up (turn limit)";
		case "stopped":
			return "Stopped";
		default:
			return "Done";
	}
}

/** Parenthetical status note on a completed foreground result. */
export function statusNote(status: SubagentStatus): string {
	switch (status) {
		case "aborted":
			return " (aborted — max turns exceeded, output may be incomplete)";
		case "steered":
			return " (wrapped up — reached turn limit)";
		case "stopped":
			return " (stopped by user)";
		default:
			return "";
	}
}

function durationMs(run: SubagentRun): number {
	return (run.endedAt ?? Date.now()) - run.startedAt;
}

function tokenString(run: SubagentRun): string {
	const total = run.totalTokens;
	return total > 0 ? formatTokens(total) : "";
}

function rawResult(run: SubagentRun): string {
	return run.resultText?.trim() || "No output.";
}

export interface AgentDetails {
	displayName: string;
	description?: string;
	subagentType: string;
	modelName?: string;
	tags?: string[];
	toolUses: number;
	tokens: string;
	turnCount?: number;
	maxTurns?: number;
	durationMs: number;
	status: SubagentStatus;
	agentId: string;
	error?: string;
}

function detailBase(
	run: SubagentRun,
): Pick<
	AgentDetails,
	"displayName" | "description" | "subagentType" | "modelName" | "tags"
> {
	const base: Pick<
		AgentDetails,
		"displayName" | "description" | "subagentType" | "modelName" | "tags"
	> = {
		displayName: run.displayName,
		description: run.description,
		subagentType: run.subagentType,
	};
	if (run.modelName) base.modelName = run.modelName;
	if (run.tags.length > 0) base.tags = [...run.tags];
	return base;
}

/** Details for a terminal or running foreground result. */
export function buildAgentDetails(
	run: SubagentRun,
	overrides?: Partial<AgentDetails>,
): AgentDetails {
	return {
		...detailBase(run),
		toolUses: run.toolUses,
		tokens: tokenString(run),
		turnCount: run.turnCount,
		maxTurns: run.maxTurns,
		durationMs: durationMs(run),
		status: run.status,
		agentId: run.id,
		error: run.error,
		...overrides,
	};
}

/** Details for the immediate background launch return. */
export function buildBackgroundDetails(run: SubagentRun): AgentDetails {
	return {
		...detailBase(run),
		toolUses: 0,
		tokens: "",
		durationMs: 0,
		status: "background",
		agentId: run.id,
	};
}

function resultPreview(run: SubagentRun, maxLen: number): string {
	const result = rawResult(run);
	return result.length > maxLen ? `${result.slice(0, maxLen)}…` : result;
}

export interface NotificationDetails {
	id: string;
	description: string;
	status: SubagentStatus;
	toolUses: number;
	turnCount: number;
	maxTurns?: number;
	totalTokens: number;
	durationMs: number;
	outputFile?: string;
	error?: string;
	resultPreview: string;
}

export function buildNotificationDetails(
	run: SubagentRun,
	maxLen: number,
): NotificationDetails {
	return {
		id: run.id,
		description: run.description ?? "",
		status: run.status,
		toolUses: run.toolUses,
		turnCount: run.turnCount,
		maxTurns: run.maxTurns,
		totalTokens: run.totalTokens,
		durationMs: run.endedAt ? run.endedAt - run.startedAt : 0,
		outputFile: run.outputFile,
		error: run.error,
		resultPreview: resultPreview(run, maxLen),
	};
}

/**
 * Completed notification text: a status line followed by the child's final
 * summary, delivered in full while it fits inside `NOTIFICATION_RESULT_LIMIT`.
 *
 * Paseo renders a custom message's text as a timeline item in addition to the
 * adapter mapping and merges it with the parent's preceding assistant text, so
 * the content is plain text (no XML) and leads with a blank line. The structured
 * fields live in `details`, which is what Paseo's adapter reads.
 */
export function buildNotificationText(run: SubagentRun): string {
	const label = run.description?.trim() || run.displayName || run.id;
	let header: string;
	if (run.status === "error") {
		header = `Agent "${label}" failed: ${run.error ?? "unknown"}.`;
	} else if (run.status === "stopped") {
		header = `Agent "${label}" stopped.`;
	} else if (run.status === "aborted") {
		header = `Agent "${label}" aborted (turn limit).`;
	} else {
		const parts: string[] = [];
		if (run.toolUses > 0)
			parts.push(`${run.toolUses} tool use${run.toolUses === 1 ? "" : "s"}`);
		const tokens = tokenString(run);
		if (tokens) parts.push(tokens);
		if (run.endedAt) parts.push(formatMs(run.endedAt - run.startedAt));
		const stats = parts.length > 0 ? ` (${parts.join(", ")})` : "";
		const steered =
			run.status === "steered" ? " (wrapped up at the turn limit)" : "";
		header = `Agent "${label}" completed${steered}${stats}.`;
	}
	const result = run.resultText?.trim();
	let body: string;
	if (!result) {
		body = header;
	} else if (result.length <= NOTIFICATION_RESULT_LIMIT) {
		body = `${header}\n\n${result}`;
	} else {
		body =
			`${header}\n\n${result.slice(0, NOTIFICATION_RESULT_LIMIT)}\n\n` +
			`...(final response truncated at ${NOTIFICATION_RESULT_LIMIT} characters; ` +
			"call get_subagent_result for the full output)";
	}
	// Lead with a blank line: Paseo concatenates consecutive assistant-message
	// timeline items, so without it the notice runs into the parent's own text.
	return `\n\n${body}`;
}

/**
 * Delivery options for the completion notification.
 *
 * The notification is always sent because Paseo's tintinweb adapter derives the
 * child's terminal status from its `details`; suppressing it entirely leaves the
 * child stuck "working". Only the wake-up turn is skipped when a caller already
 * claimed the result with `get_subagent_result`.
 */
export function notificationDeliveryOptions(run: SubagentRun): {
	deliverAs: "followUp";
	triggerTurn: boolean;
} {
	return { deliverAs: "followUp", triggerTurn: !run.resultRequested };
}

/** Full-result budget for the completion notification before it points at the tool. */
export const NOTIFICATION_RESULT_LIMIT = 10_000;

/** Structured `<task-notification>` block, matching Claude Code's XML shape. */
export function formatTaskNotification(
	run: SubagentRun,
	maxLen: number,
): string {
	const result = rawResult(run);
	const preview =
		result.length > maxLen
			? `${result.slice(0, maxLen)}\n...(truncated, use get_subagent_result for full output)`
			: result;
	const contextXml =
		run.contextPercent != null
			? `<context_percent>${Math.round(run.contextPercent)}</context_percent>`
			: "";
	const lines: Array<string | null> = [
		"<task-notification>",
		`<task-id>${run.id}</task-id>`,
		run.toolCallId
			? `<tool-use-id>${escapeXml(run.toolCallId)}</tool-use-id>`
			: null,
		run.outputFile
			? `<output-file>${escapeXml(run.outputFile)}</output-file>`
			: null,
		`<status>${escapeXml(statusLabel(run.status, run.error))}</status>`,
		`<summary>Agent "${escapeXml(run.description ?? "")}" ${run.status}</summary>`,
		`<result>${escapeXml(preview)}</result>`,
		`<usage><total_tokens>${run.totalTokens}</total_tokens><tool_uses>${run.toolUses}</tool_uses>${contextXml}<duration_ms>${durationMs(run)}</duration_ms></usage>`,
		"</task-notification>",
	];
	return lines.filter((line): line is string => line !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Tool result text
// ---------------------------------------------------------------------------

/** Guidance returned when the caller still passes the ignored `run_in_background`. */
export const RUN_IN_BACKGROUND_NOTE =
	"Note: run_in_background is deprecated and ignored; every child runs in the background so its transcript can stream. Use get_subagent_result with wait: true to block for the result.";

export function buildBackgroundResultText(
	run: SubagentRun,
	options: { queued?: boolean; maxConcurrent?: number; note?: string } = {},
): string {
	const queued = options.queued === true;
	return (
		(options.note ? `${options.note}\n\n` : "") +
		`Agent ${queued ? "queued" : "started"} in background.\n` +
		`Agent ID: ${run.id}\n` +
		`Type: ${run.displayName}\n` +
		`Description: ${run.description ?? ""}\n` +
		(run.outputFile ? `Output file: ${run.outputFile}\n` : "") +
		(queued
			? `Position: queued (max ${options.maxConcurrent ?? 0} concurrent)\n`
			: "") +
		`\nYou will be notified when this agent completes, unless you block for it first:\n` +
		`Use get_subagent_result with wait: true to block for the result (that also replaces the notification), or steer_subagent to send it messages.\n` +
		`Do not duplicate this agent's work.`
	);
}

/**
 * The spawn result content for a foreground run.
 *
 * Unlike tintinweb, it ends with the unadorned `Output file:` line so Paseo can
 * attach the child transcript to the finished foreground run (spec §8). Paseo's
 * tintinweb adapter reads that line from the spawn result only.
 */
export function buildForegroundResultText(run: SubagentRun): string {
	const outputLine = run.outputFile ? `\nOutput file: ${run.outputFile}` : "";
	if (run.status === "error") {
		return `Agent failed: ${run.error ?? "unknown"}${outputLine}`;
	}
	const statsParts = [`${run.toolUses} tool uses`];
	const tokens = tokenString(run);
	if (tokens) statsParts.push(tokens);
	return (
		`Agent completed in ${formatMs(durationMs(run))} (${statsParts.join(", ")})${statusNote(run.status)}.\n\n` +
		`${rawResult(run)}${outputLine}`
	);
}

export function buildGetResultText(run: SubagentRun): string {
	const statsParts = [`Tool uses: ${run.toolUses}`];
	const tokens = tokenString(run);
	if (tokens) statsParts.push(tokens);
	if (run.contextPercent != null)
		statsParts.push(`Context: ${Math.round(run.contextPercent)}%`);
	statsParts.push(`Duration: ${formatDuration(run.startedAt, run.endedAt)}`);

	let output =
		`Agent: ${run.id}\n` +
		`Type: ${run.displayName} | Status: ${run.status} | ${statsParts.join(" | ")}\n` +
		`Description: ${run.description ?? ""}\n\n`;
	if (
		run.status === "running" ||
		run.status === "queued" ||
		run.status === "background"
	) {
		output += "Agent is still running. Use wait: true or check back later.";
	} else if (run.status === "error") {
		output += `Error: ${run.error ?? "unknown"}`;
	} else {
		output += rawResult(run);
	}
	return output;
}

export function buildNotFoundText(agentId: string): string {
	return `Agent not found: "${agentId}". It may have been cleaned up.`;
}

export function buildSteerSentText(run: SubagentRun): string {
	const stateParts: string[] = [];
	const tokens = tokenString(run);
	if (tokens) stateParts.push(tokens);
	stateParts.push(
		`${run.toolUses} tool ${run.toolUses === 1 ? "use" : "uses"}`,
	);
	if (run.contextPercent != null)
		stateParts.push(`context ${Math.round(run.contextPercent)}% full`);
	return (
		`Steering message sent to agent ${run.id}. The agent will process it after its current tool execution.\n` +
		`Current state: ${stateParts.join(" · ")}`
	);
}

export function buildSteerNotRunningText(run: SubagentRun): string {
	return `Agent "${run.id}" is not running (status: ${run.status}). Cannot steer a non-running agent.`;
}

/** `subagents:created` payload, matching tintinweb. */
export function buildCreatedEvent(run: SubagentRun): Record<string, unknown> {
	return {
		id: run.id,
		type: run.subagentType,
		description: run.description,
		isBackground: true,
	};
}

/** `subagents:started` payload, matching tintinweb. */
export function buildStartedEvent(run: SubagentRun): Record<string, unknown> {
	return { id: run.id, type: run.subagentType, description: run.description };
}

/** `subagents:steered` payload, matching tintinweb. */
export function buildSteeredEvent(
	run: SubagentRun,
	message: string,
): Record<string, unknown> {
	return { id: run.id, message };
}

/**
 * Cross-extension lifecycle payload, matching tintinweb's `buildEventData`.
 * `tokens` is omitted when nothing was produced.
 */
export function buildEventData(run: SubagentRun): Record<string, unknown> {
	const total = run.totalTokens;
	const data: Record<string, unknown> = {
		id: run.id,
		type: run.subagentType,
		description: run.description,
		result: run.resultText?.trim() || undefined,
		error: run.error,
		status: run.status,
		toolUses: run.toolUses,
		durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
	};
	if (total > 0) {
		data.tokens = {
			input: run.lifetimeUsage.input,
			output: run.lifetimeUsage.output,
			total,
		};
	}
	return data;
}
