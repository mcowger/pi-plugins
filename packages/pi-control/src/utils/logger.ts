import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Action, DecisionsConfig } from "../config.js";
import type {
	AnswerBuckets,
	BackstopResult,
	DecisionsQuestion,
	DecisionsResponse,
	DecisionsState,
	Stage1Result,
	Verdict,
} from "./decisions.js";
import type { AppliedAutoConfig, AutoBuckets } from "./auto-decisions.js";
import type { AutoState } from "./auto-state.js";
import type { ScopeSource } from "./scope.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const logPath = resolve(getAgentDir(), "extensions", "pi-controls.log");

/** Tuning knobs actually applied to a classification (post-merge). */
export type AppliedTuningConfig = Pick<
	DecisionsConfig,
	| "yesThreshold"
	| "noThreshold"
	| "choiceConfidence"
	| "riskyMassThreshold"
	| "backstopThreshold"
	| "weights"
>;

/** The request half of a classified trace, shared by eval and auto. */
export interface DecisionsRequestTrace<S> {
	url: string;
	model: string;
	state: S;
	questions: Record<string, DecisionsQuestion>;
}

/** The evaluation half of a classified trace, shared by eval and auto. */
export interface DecisionsEvaluationTrace<B, C> {
	buckets: B;
	appliedConfig: C;
	stage1: Stage1Result;
	/** Always computed, even when Stage 1 already decided. */
	stage2: BackstopResult;
	verdict: Verdict;
}

/** Full-fidelity classified trace — the future auto-tuning dataset. */
export interface EvalClassifiedTrace {
	kind: "classified";
	language: string;
	interpreter: string;
	origin: string;
	truncated: boolean;
	request: DecisionsRequestTrace<DecisionsState>;
	response: DecisionsResponse;
	evaluation: DecisionsEvaluationTrace<AnswerBuckets, AppliedTuningConfig>;
	latencyMs: number;
}

/** Eval shape detected but source not statically recoverable — no API call. */
export interface EvalUnavailableTrace {
	kind: "unavailable";
	interpreter: string;
	detail: string;
	action: Verdict;
}

/** API/network/auth/timeout/malformed failure — no usable answers. */
export interface EvalErrorTrace {
	kind: "error";
	interpreter: string;
	detail: string;
	action: Verdict;
	latencyMs?: number;
}

/**
 * Session-cache hit. The full trace was logged on first classification;
 * `key` joins them.
 */
export interface EvalCachedTrace {
	kind: "cached";
	key: string;
	verdict: Verdict;
}

export type EvalTrace =
	| EvalClassifiedTrace
	| EvalUnavailableTrace
	| EvalErrorTrace
	| EvalCachedTrace;

/** Full-fidelity auto classified trace — the future auto-tuning dataset. */
export interface AutoClassifiedTrace {
	kind: "auto-classified";
	request: DecisionsRequestTrace<AutoState>;
	response: DecisionsResponse;
	evaluation: DecisionsEvaluationTrace<AutoBuckets, AppliedAutoConfig> & {
		/** Whether `scope` came from resolved paths, a fallback, or the model. */
		scopeSource: ScopeSource;
	};
	latencyMs: number;
}

/** Auto is in play but the Decisions API is not configured — no call. */
export interface AutoUnavailableTrace {
	kind: "auto-unavailable";
	detail: string;
	action: Verdict;
}

/** API/network/auth/timeout/malformed failure — no usable answers. */
export interface AutoErrorTrace {
	kind: "auto-error";
	detail: string;
	action: Verdict;
	latencyMs: number;
}

/**
 * Session-cache hit. The full trace was logged on first classification;
 * `key` joins them.
 */
export interface AutoCachedTrace {
	kind: "auto-cached";
	key: string;
	verdict: Verdict;
}

export type AutoTrace =
	| AutoClassifiedTrace
	| AutoUnavailableTrace
	| AutoErrorTrace
	| AutoCachedTrace;

/** Why the auto evaluation was bypassed without an API call. */
export type AutoSkipReason = "eval-classified" | "session-allow";

interface LogEntry {
	ts: string;
	tool: string;
	command?: string;
	cwd: string;
	targets: string[];
	policyName: string | null;
	action: Action | "pass";
	reason?: string;
	/** One trace per eval source, in stage order. */
	evals?: EvalTrace[];
	/** Set when the feature is configured but bypassed by approval. */
	evalSkipped?: "session-allow" | "approval-rule";
	/** Auto-action trace, when the `auto` action was evaluated for this call. */
	auto?: AutoTrace;
	/** Set when the auto feature is in play but bypassed. */
	autoSkipped?: AutoSkipReason;
}

export async function logDecision(entry: LogEntry): Promise<void> {
	try {
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// Never let logging break the extension.
	}
}

export async function logStartup(message: string): Promise<void> {
	try {
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(
			logPath,
			`${JSON.stringify({ ts: new Date().toISOString(), startup: message })}\n`,
			"utf-8",
		);
	} catch {
		// Ignore.
	}
}

export { type LogEntry };
