/**
 * Durable transcript entries for live `auto` verdicts.
 *
 * Each time the `auto` classifier runs and resolves to allow or deny,
 * pi-controls can append a custom session entry. Custom entries are rendered in
 * the interactive transcript through a registered entry renderer but never
 * participate in LLM context, so the user can watch evaluations happen without
 * spending tokens.
 */

/** Custom session-entry type for an auto verdict transcript entry. */
export const AUTO_ENTRY_TYPE = "pi-controls-auto";

/** What a live auto verdict reports to the transcript sink. */
export interface AutoVerdictInfo {
	tool: string;
	/** bash command, or null for non-bash tools. */
	command: string | null;
	verdict: "allow" | "deny";
	/** Human-readable rationale, without the "auto: " prefix. */
	explanation: string;
	/** Resolved target paths the classifier considered. */
	targets: string[];
}

/** Receives live auto verdicts that should be surfaced in the transcript. */
export type AutoVerdictSink = (info: AutoVerdictInfo) => void;

/** Persisted shape of an auto verdict transcript entry. */
export interface AutoTranscriptEntry extends AutoVerdictInfo {
	ts: string;
}

/** Attach a timestamp, producing the durable entry payload. */
export function toAutoTranscriptEntry(
	info: AutoVerdictInfo,
	now: () => string = () => new Date().toISOString(),
): AutoTranscriptEntry {
	return { ...info, ts: now() };
}
