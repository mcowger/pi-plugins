/**
 * Decision logging (REQUIREMENTS R10).
 *
 * One JSON line per turn, appended with a single `O_APPEND` write to
 * `decisions-YYYY-MM-DD.jsonl` (UTC date). Never logs prompt or message
 * text, previews, API keys or request/response bodies. Errors are capped at
 * 200 characters.
 */

import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tier } from "./bundle.js";
import { canonicalJson } from "./context/entries.js";
import type { ActualSource, Origin } from "./origin.js";

export interface CandidateLogEntry {
	tier: Tier | null;
	probs: Record<Tier, number> | null;
	tier_expected: number | null;
	confidence: number | null;
	latency_ms: number;
	input_tokens: number | null;
	cost: number | null;
	excluded_exemplars?: number;
	exemplars?: string[];
	error: string | null;
}

export interface DecisionRecord {
	schema: 1;
	ts: string;
	session_file: string | null;
	session_id: string;
	entry_id: string | null;
	parent_session: string | null;
	cwd: string;
	origin: Origin;
	skill_name: string | null;
	is_subagent_session: boolean;
	is_ack: boolean;
	actual: {
		provider: string;
		model: string | null;
		thinking: string | null;
		tier: Tier | null;
		source: ActualSource;
	};
	prompt_chars: number;
	prompt_norm_hash: string;
	state_hash: string;
	structural: {
		message_count: number;
		has_images: boolean;
		api_type: string;
	};
	bundle_version: string;
	embedding: { latency_ms: number | null; error: string | null };
	candidates: Record<string, CandidateLogEntry>;
	skipped: string | null;
	handler_ms: number;
}

export const MAX_ERROR_CHARS = 200;

/** sha256 hex of the canonical state JSON (mirrors `sha256_obj`). */
export function hashState(state: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(state), "utf8")
		.digest("hex");
}

/** Cap an error string at 200 characters (R10.6). */
export function capErrorText(message: string): string {
	const text = String(message);
	if (Array.from(text).length <= MAX_ERROR_CHARS) return text;
	return `${Array.from(text).slice(0, MAX_ERROR_CHARS).join("")}…`;
}

/** UTC `YYYY-MM-DD` for the log filename. */
export function utcDate(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

async function appendLine(
	logDir: string,
	filePrefix: string,
	record: unknown,
	now?: number,
): Promise<void> {
	await mkdir(logDir, { recursive: true, mode: 0o700 });
	const path = join(logDir, `${filePrefix}-${utcDate(now)}.jsonl`);
	await appendFile(path, `${JSON.stringify(record)}\n`, {
		flag: "a",
		mode: 0o600,
	});
}

/** Append one decision record with a single write. */
export async function appendDecision(
	logDir: string,
	record: DecisionRecord,
): Promise<void> {
	await appendLine(logDir, "decisions", record);
}

/** Append one background error (never surfaces in the transcript). */
export async function appendError(
	logDir: string,
	record: { ts: string; where: string; error: string },
): Promise<void> {
	await appendLine(logDir, "errors", record);
}
