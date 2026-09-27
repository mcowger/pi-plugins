import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Action, DecisionsConfig } from "../config.js";
import type {
	AnswerBuckets,
	BackstopResult,
	DecisionsAnswer,
	DecisionsQuestion,
	DecisionsState,
	DecisionsUsage,
	Stage1Result,
} from "./decisions.js";
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

/** Full-fidelity classified trace — the future auto-tuning dataset. */
export interface EvalClassifiedTrace {
	kind: "classified";
	language: string;
	interpreter: string;
	origin: string;
	truncated: boolean;
	request: {
		url: string;
		model: string;
		state: DecisionsState;
		questions: Record<string, DecisionsQuestion>;
	};
	response: {
		id: string;
		model: string;
		provider: string;
		answers: Record<string, DecisionsAnswer>;
		usage: DecisionsUsage;
	};
	evaluation: {
		buckets: AnswerBuckets;
		appliedConfig: AppliedTuningConfig;
		stage1: Stage1Result;
		/** Always computed, even when Stage 1 already decided. */
		stage2: BackstopResult;
		verdict: "allow" | "ask" | "deny";
	};
	latencyMs: number;
}

/** Eval shape detected but source not statically recoverable — no API call. */
export interface EvalUnavailableTrace {
	kind: "unavailable";
	interpreter: string;
	detail: string;
	action: "allow" | "ask" | "deny";
}

/** API/network/auth/timeout/malformed failure — no usable answers. */
export interface EvalErrorTrace {
	kind: "error";
	interpreter: string;
	detail: string;
	action: "allow" | "ask" | "deny";
	latencyMs?: number;
}

/**
 * Session-cache hit. The full trace was logged on first classification;
 * `key` joins them.
 */
export interface EvalCachedTrace {
	kind: "cached";
	key: string;
	verdict: "allow" | "ask" | "deny";
}

export type EvalTrace =
	| EvalClassifiedTrace
	| EvalUnavailableTrace
	| EvalErrorTrace
	| EvalCachedTrace;

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
