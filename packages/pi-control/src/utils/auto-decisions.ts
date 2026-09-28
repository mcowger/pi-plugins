/**
 * Decisions-API classification for the `auto` action.
 *
 * When a tool call's combined action is `auto`, the call's context (see
 * ./auto-state.ts) is sent to the Decisions router with a universal
 * capability/blast-radius question set. A deterministic two-stage engine maps
 * the answers to a terminal verdict:
 *
 *   Stage 1 — rule table over bucketed answers (decisive, explainable).
 *             The only stage that can produce "deny".
 *   Stage 2 — weighted-score backstop over raw probabilities, catching
 *             accumulated weak signals when no rule fired. Caps at "ask".
 *             Always computed (even when Stage 1 decided) so logs carry
 *             rule-verdict-vs-score pairs for future tuning.
 *
 * Transport is the official `@typesafe-ai/sdk` client (see ./decisions.ts
 * postDecisions). All network/auth/malformed failures throw DecisionsError for
 * the caller to map via config.errorAction.
 */

import { createHash } from "node:crypto";
import type {
	AutoConfig,
	AutoQuestionOverride,
	DecisionsConfig,
} from "../config.js";
import type { AutoState } from "./auto-state.js";
import {
	asChoice,
	asNoul,
	type BackstopResult,
	bucketChoice,
	bucketNoul,
	createVerdictCache,
	DecisionsError,
	type DecisionsAnswer,
	type DecisionsChoiceAnswer,
	type DecisionsQuestion,
	type DecisionsResponse,
	postDecisions,
	round4,
	type Stage1Result,
	type Verdict,
} from "./decisions.js";

export const AUTO_ACTION_CLASS_QUESTION = "action_class";
export const AUTO_SCOPE_QUESTION = "scope";
export const AUTO_DATA_SENSITIVITY_QUESTION = "data_sensitivity";
export const AUTO_DESTRUCTIVE_QUESTION = "destructive";
export const AUTO_NETWORK_QUESTION = "network";
export const AUTO_CONCEALED_QUESTION = "concealed";
export const AUTO_INFERENCE_CALL_QUESTION = "inference_call";

// ─── Questions ────────────────────────────────────────────────────────────────

function defaultQuestions(): Record<string, DecisionsQuestion> {
	return {
		[AUTO_ACTION_CLASS_QUESTION]: {
			type: "choice",
			instructions: "What is the primary effect of this call?",
			criteria: {
				none: "No side effects: inspection, metadata, read-only query.",
				local_read: "Reads local filesystem data that is already present.",
				local_write:
					"Creates, modifies, or deletes local files or local state.",
				process_exec: "Executes a program, command, or inline code.",
				remote_read: "Fetches data from a remote system without changing it.",
				remote_write:
					"Changes state on a remote system (push, PR/merge, posted API change, publish).",
				unknown: "The effect cannot be determined from the call.",
			},
		},
		[AUTO_SCOPE_QUESTION]: {
			type: "choice",
			instructions: "Relative to the cwd, where does the call's effect land?",
			criteria: {
				within: "Inside the working project.",
				temporary:
					"Ephemeral temp space (/tmp, mktemp, OS temp dirs) used transiently by the call: created by it, or cleaned up as part of it. Deleting or modifying files the call did not just create is not temporary — classify by where those files live.",
				outside:
					"Outside the cwd and not sensitive (another project, home miscellany, persistent files kept under /tmp).",
				sensitive_system:
					"OS directories (/etc, /usr, /bin), credential stores (~/.ssh, keychains), other users' files, service/scheduled-task definitions.",
				remote: "A remote system (no local path).",
				not_applicable: "No filesystem or remote target.",
				unknown:
					"Paths are constructed dynamically and cannot be resolved, or the target is indeterminable.",
			},
		},
		[AUTO_DATA_SENSITIVITY_QUESTION]: {
			type: "choice",
			instructions:
				"What is the most sensitive data this call reads, transmits, or exposes?",
			criteria: {
				none: "No reads beyond its own literal inputs, or no reads at all.",
				ordinary:
					"Project files, public data, source code (even auth-related code), the agent's own configuration, fields merely named 'token', 'key', or 'secret' in ordinary data, or redacted/aggregated output.",
				sensitive:
					"Actual credentials (private keys, ~/.ssh, *.pem, .env, secret env vars); standing credential stores (models.yml, credential config); shared daemon or system logs; other users' or clients' private data; data singling out a specific person, device, or client; or local file contents transmitted to a remote destination.",
				unknown:
					"Read targets are constructed dynamically and sensitivity cannot be determined.",
			},
		},
		[AUTO_DESTRUCTIVE_QUESTION]: {
			type: "noul",
			instructions:
				"Does this call destroy or irreversibly alter data, or disrupt systems, services, or processes?",
			criteria: {
				true: "Deletes files or directories (rm, unlink, rmtree, DROP TABLE), wipes or formats storage, kills or disrupts processes/services, revokes credentials, makes an unrecoverable overwrite, fork bombs or resource exhaustion.",
				false:
					"Reads, creates new files, additive changes, or fully reversible changes — including deletes and edits confined to version-controlled working trees, backups, or scratch space.",
			},
		},
		[AUTO_NETWORK_QUESTION]: {
			type: "noul",
			instructions: "Does this call communicate with a remote system?",
			criteria: {
				true: "HTTP/API requests, DNS, sockets, SSH/FTP, git fetch/push, package installs, MCP calls to remote servers.",
				false:
					"Purely local work. Merely naming a URL string without fetching it.",
			},
		},
		[AUTO_CONCEALED_QUESTION]: {
			type: "noul",
			instructions:
				"Is this call deliberately obfuscated or structured to conceal its effect?",
			criteria: {
				true: "Base64/hex blobs decoded then executed, eval/exec of constructed strings, encrypted payloads, misleading names or dead code hiding behavior, or download-and-execute chains.",
				false:
					"Readable, obvious intent. Normal use of encoding or compression for data, without executing the decoded result.",
			},
		},
		[AUTO_INFERENCE_CALL_QUESTION]: {
			type: "noul",
			instructions:
				"Does this call invoke metered AI model inference or otherwise spend paid/token budget?",
			criteria: {
				true: "Requests to model inference endpoints (/v1/responses, /v1/chat/completions, /v1/decisions, :generate, /inference) carrying prompts or token budgets, or remote metered agentic runs.",
				false:
					"Metadata, listing, or management endpoints; local test agents; localhost harnesses; no model invocation at all.",
			},
		},
	};
}

function applyOverride(
	question: DecisionsQuestion,
	override: AutoQuestionOverride | undefined,
): DecisionsQuestion {
	if (!override) return question;
	if (question.type === "noul") {
		const criteria = {
			...(question.criteria ?? { true: "", false: "" }),
		};
		if (override.criteria?.true) criteria.true = override.criteria.true;
		if (override.criteria?.false) criteria.false = override.criteria.false;
		return {
			type: "noul",
			instructions: override.instructions ?? question.instructions,
			criteria,
		};
	}
	const criteria = { ...question.criteria };
	if (override.criteria) Object.assign(criteria, override.criteria);
	return {
		type: "choice",
		instructions: override.instructions ?? question.instructions,
		criteria,
	};
}

/** Build the auto question set with per-question config overrides applied. */
export function buildQuestions(
	overrides: Record<string, AutoQuestionOverride> = {},
): Record<string, DecisionsQuestion> {
	const defaults = defaultQuestions();
	const merged: Record<string, DecisionsQuestion> = {};
	for (const [name, question] of Object.entries(defaults)) {
		merged[name] = applyOverride(question, overrides[name]);
	}
	return merged;
}

// ─── Buckets ──────────────────────────────────────────────────────────────────

export type NoulBucket = "yes" | "no" | "uncertain";

export interface AutoBuckets {
	action_class: string;
	scope: string;
	data_sensitivity: string;
	destructive: NoulBucket;
	network: NoulBucket;
	concealed: NoulBucket;
	inference_call: NoulBucket;
}

export interface AutoProbabilities {
	destructive: number;
	concealed: number;
	network: number;
	inference_call: number;
	scope: Record<string, number>;
	data_sensitivity: Record<string, number>;
}

/**
 * Tuning actually applied to an auto evaluation, for the log trace. Context
 * limits (`maxInputBytes`, `maxConversationTurns`, `maxConversationBytes`) and
 * question overrides are omitted — their effect is already visible in the
 * logged `request.state` and `request.questions`.
 */
export type AppliedAutoConfig = Pick<
	AutoConfig,
	| "deny"
	| "yesThreshold"
	| "noThreshold"
	| "choiceConfidence"
	| "riskyMassThreshold"
	| "backstopThreshold"
	| "weights"
>;

export function appliedAutoConfig(auto: AutoConfig): AppliedAutoConfig {
	return {
		deny: auto.deny,
		yesThreshold: auto.yesThreshold,
		noThreshold: auto.noThreshold,
		choiceConfidence: auto.choiceConfidence,
		riskyMassThreshold: auto.riskyMassThreshold,
		backstopThreshold: auto.backstopThreshold,
		weights: auto.weights,
	};
}

/** Labels carrying escalation mass for the risky-mass bucket rule. */
export const SCOPE_RISKY_LABELS = new Set([
	"outside",
	"sensitive_system",
	"unknown",
]);
export const DATA_RISKY_LABELS = new Set(["sensitive", "unknown"]);
export const ACTION_RISKY_LABELS = new Set(["remote_write", "unknown"]);

export interface AutoLabelSets {
	action_class: Set<string>;
	scope: Set<string>;
	data_sensitivity: Set<string>;
}

function assertKnownLabel(
	question: string,
	answer: DecisionsChoiceAnswer,
	allowed: Set<string> | undefined,
): void {
	if (allowed && allowed.size > 0 && !allowed.has(answer.choice)) {
		throw new DecisionsError(
			`malformed answer for "${question}": unknown label "${answer.choice}"`,
			"malformed",
		);
	}
}

export function bucketAnswers(
	answers: Record<string, DecisionsAnswer>,
	config: AutoConfig,
	allowedLabels?: AutoLabelSets,
): { buckets: AutoBuckets; probs: AutoProbabilities } {
	const names = [
		AUTO_ACTION_CLASS_QUESTION,
		AUTO_SCOPE_QUESTION,
		AUTO_DATA_SENSITIVITY_QUESTION,
		AUTO_DESTRUCTIVE_QUESTION,
		AUTO_NETWORK_QUESTION,
		AUTO_CONCEALED_QUESTION,
		AUTO_INFERENCE_CALL_QUESTION,
	];
	for (const name of names) {
		if (!answers[name]) {
			throw new DecisionsError(`missing answer for "${name}"`, "malformed");
		}
	}
	const actionAnswer = asChoice(
		AUTO_ACTION_CLASS_QUESTION,
		answers[AUTO_ACTION_CLASS_QUESTION],
	);
	const scopeAnswer = asChoice(
		AUTO_SCOPE_QUESTION,
		answers[AUTO_SCOPE_QUESTION],
	);
	const dataAnswer = asChoice(
		AUTO_DATA_SENSITIVITY_QUESTION,
		answers[AUTO_DATA_SENSITIVITY_QUESTION],
	);
	if (allowedLabels) {
		assertKnownLabel(
			AUTO_ACTION_CLASS_QUESTION,
			actionAnswer,
			allowedLabels.action_class,
		);
		assertKnownLabel(AUTO_SCOPE_QUESTION, scopeAnswer, allowedLabels.scope);
		assertKnownLabel(
			AUTO_DATA_SENSITIVITY_QUESTION,
			dataAnswer,
			allowedLabels.data_sensitivity,
		);
	}
	const probs: AutoProbabilities = {
		destructive: asNoul(
			AUTO_DESTRUCTIVE_QUESTION,
			answers[AUTO_DESTRUCTIVE_QUESTION],
		),
		network: asNoul(AUTO_NETWORK_QUESTION, answers[AUTO_NETWORK_QUESTION]),
		concealed: asNoul(
			AUTO_CONCEALED_QUESTION,
			answers[AUTO_CONCEALED_QUESTION],
		),
		inference_call: asNoul(
			AUTO_INFERENCE_CALL_QUESTION,
			answers[AUTO_INFERENCE_CALL_QUESTION],
		),
		scope: scopeAnswer.probabilities ?? { [scopeAnswer.choice]: 1 },
		data_sensitivity: dataAnswer.probabilities ?? { [dataAnswer.choice]: 1 },
	};
	const buckets: AutoBuckets = {
		action_class: bucketChoice(
			actionAnswer,
			config.choiceConfidence,
			config.riskyMassThreshold,
			ACTION_RISKY_LABELS,
		),
		scope: bucketChoice(
			scopeAnswer,
			config.choiceConfidence,
			config.riskyMassThreshold,
			SCOPE_RISKY_LABELS,
		),
		data_sensitivity: bucketChoice(
			dataAnswer,
			config.choiceConfidence,
			config.riskyMassThreshold,
			DATA_RISKY_LABELS,
		),
		destructive: bucketNoul(
			probs.destructive,
			config.yesThreshold,
			config.noThreshold,
		),
		network: bucketNoul(probs.network, config.yesThreshold, config.noThreshold),
		concealed: bucketNoul(
			probs.concealed,
			config.yesThreshold,
			config.noThreshold,
		),
		inference_call: bucketNoul(
			probs.inference_call,
			config.yesThreshold,
			config.noThreshold,
		),
	};
	return { buckets, probs };
}

// ─── Stage 1: rule table ──────────────────────────────────────────────────────

function rule(verdict: "deny" | "ask", id: string): Stage1Result {
	return { verdict, rule: id };
}

/**
 * First match wins — deny rules before ask rules. With `denyEnabled` false the
 * deny rules are skipped entirely, capping every outcome at ask.
 */
export function applyStage1(
	buckets: AutoBuckets,
	denyEnabled = true,
): Stage1Result {
	const scope = buckets.scope;
	const data = buckets.data_sensitivity;
	const actionClass = buckets.action_class;

	if (denyEnabled) {
		if (
			buckets.destructive === "yes" &&
			(scope === "outside" || scope === "sensitive_system")
		) {
			return rule("deny", "destructive-out-of-scope");
		}
		if (buckets.destructive === "yes" && buckets.concealed === "yes") {
			return rule("deny", "destructive-concealed");
		}
		if (data === "sensitive" && buckets.network === "yes") {
			return rule("deny", "exfil-shape");
		}
		if (
			buckets.concealed === "yes" &&
			(buckets.network === "yes" || actionClass === "process_exec")
		) {
			return rule("deny", "concealed-capability");
		}
	}

	if (buckets.destructive === "yes") {
		return rule("ask", "destructive");
	}
	if (actionClass === "local_write" && SCOPE_RISKY_LABELS.has(scope)) {
		return rule("ask", "write-out-of-scope");
	}
	if (DATA_RISKY_LABELS.has(data)) {
		return rule("ask", "sensitive-read");
	}
	if (buckets.concealed === "yes") {
		return rule("ask", "concealed-alone");
	}
	if (buckets.inference_call === "yes") {
		return rule("ask", "inference-call");
	}
	if (
		buckets.destructive === "uncertain" ||
		buckets.concealed === "uncertain" ||
		scope === "uncertain" ||
		scope === "unknown" ||
		data === "uncertain" ||
		actionClass === "unknown" ||
		actionClass === "uncertain"
	) {
		return rule("ask", "uncertain-critical");
	}
	return { verdict: null, rule: null };
}

// ─── Stage 2: score backstop ──────────────────────────────────────────────────

function riskyMass(
	probabilities: Record<string, number>,
	riskyLabels: Set<string>,
): number {
	let mass = 0;
	for (const label of riskyLabels) mass += probabilities[label] ?? 0;
	return mass;
}

/**
 * Weighted sum over raw probabilities. Never denies — returns whether the
 * ask threshold was breached, with per-signal contributions for the log.
 */
export function scoreBackstop(
	probs: AutoProbabilities,
	config: AutoConfig,
): BackstopResult {
	const w = config.weights;
	const raw: Record<string, number> = {
		destructive: probs.destructive * w.destructive,
		concealed: probs.concealed * w.concealed,
		network: probs.network * w.network,
		inferenceCall: probs.inference_call * w.inferenceCall,
		scopeRisky: riskyMass(probs.scope, SCOPE_RISKY_LABELS) * w.scopeRisky,
		sensitiveData:
			riskyMass(probs.data_sensitivity, DATA_RISKY_LABELS) * w.sensitiveData,
	};
	const contributions: Record<string, number> = {};
	let score = 0;
	for (const [name, value] of Object.entries(raw)) {
		if (value > 0) {
			contributions[name] = round4(value);
			score += value;
		}
	}
	return {
		score: round4(score),
		threshold: config.backstopThreshold,
		breached: score >= config.backstopThreshold,
		contributions,
	};
}

// ─── Client ───────────────────────────────────────────────────────────────────

let fallbackSessionId: string | null = null;

function getFallbackSessionId(): string {
	fallbackSessionId ??= `pi-controls-auto-${process.pid}-${Date.now()}`;
	return fallbackSessionId;
}

export interface AutoClassifyInput {
	state: AutoState;
	sessionId: string;
}

export interface AutoVerdict {
	verdict: Verdict;
	buckets: AutoBuckets;
	stage1: Stage1Result;
	stage2: BackstopResult;
	request: {
		url: string;
		model: string;
		state: AutoState;
		questions: Record<string, DecisionsQuestion>;
	};
	response: DecisionsResponse;
	latencyMs: number;
}

/** Allowed labels for a choice question, used to reject out-of-schema answers. */
function choiceLabels(question: DecisionsQuestion | undefined): Set<string> {
	if (!question || question.type !== "choice") return new Set();
	return new Set(Object.keys(question.criteria));
}

export async function classifyAuto(
	input: AutoClassifyInput,
	config: DecisionsConfig,
): Promise<AutoVerdict> {
	const auto = config.auto;
	const questions = buildQuestions(auto.questions);
	const { response, latencyMs } = await postDecisions({
		config,
		state: input.state,
		questions,
		sessionId: input.sessionId || getFallbackSessionId(),
	});
	const { buckets, probs } = bucketAnswers(response.answers, auto, {
		action_class: choiceLabels(questions[AUTO_ACTION_CLASS_QUESTION]),
		scope: choiceLabels(questions[AUTO_SCOPE_QUESTION]),
		data_sensitivity: choiceLabels(questions[AUTO_DATA_SENSITIVITY_QUESTION]),
	});
	const stage1 = applyStage1(buckets, auto.deny);
	const stage2 = scoreBackstop(probs, auto);
	const verdict: Verdict =
		stage1.verdict ?? (stage2.breached ? "ask" : "allow");
	return {
		verdict,
		buckets,
		stage1,
		stage2,
		request: {
			url: config.url,
			model: config.model,
			state: input.state,
			questions,
		},
		response,
		latencyMs,
	};
}

// ─── Session verdict cache ────────────────────────────────────────────────────

const autoVerdictCache = createVerdictCache();

export interface AutoCacheKeyInput {
	tool: string;
	/**
	 * Raw, untruncated tool input. The normalized state is byte-capped for the
	 * request, so hashing it would collide two different calls that share a
	 * truncated prefix or head/tail preview.
	 */
	rawInput: Record<string, unknown>;
	targets: string[];
	cwd: string;
	/** Keeps the cache session-scoped instead of process-global. */
	sessionId: string;
}

export function autoCacheKey(input: AutoCacheKeyInput): string {
	const signature = JSON.stringify({
		tool: input.tool,
		input: input.rawInput,
		targets: [...input.targets].sort(),
		cwd: input.cwd,
		sessionId: input.sessionId,
	});
	return `sha256:${createHash("sha256").update(signature, "utf8").digest("hex")}`;
}

export function getCachedAutoVerdict(key: string): Verdict | undefined {
	return autoVerdictCache.get(key);
}

export function setCachedAutoVerdict(key: string, verdict: Verdict): void {
	autoVerdictCache.set(key, verdict);
}

/** Exported for tests and config reloads. */
export function clearAutoCache(): void {
	autoVerdictCache.clear();
}

// ─── Rationale for user-facing messages ───────────────────────────────────────

/** Buckets worth citing: noul yes/uncertain, and non-benign choice labels. */
export function activeBuckets(buckets: AutoBuckets): string[] {
	const active: string[] = [];
	for (const name of [
		"destructive",
		"network",
		"concealed",
		"inference_call",
	] as const) {
		if (buckets[name] !== "no") active.push(`${name}=${buckets[name]}`);
	}
	if (
		!["temporary", "within", "not_applicable", "remote"].includes(buckets.scope)
	) {
		active.push(`scope=${buckets.scope}`);
	}
	if (!["none", "ordinary"].includes(buckets.data_sensitivity)) {
		active.push(`data_sensitivity=${buckets.data_sensitivity}`);
	}
	if (!["none", "local_read", "local_write"].includes(buckets.action_class)) {
		active.push(`action_class=${buckets.action_class}`);
	}
	return active;
}

export function verdictRationale(
	verdictResult: Pick<AutoVerdict, "buckets" | "stage1" | "stage2">,
): string {
	const { buckets, stage1, stage2 } = verdictResult;
	if (stage1.rule) {
		const context = activeBuckets(buckets).join(", ");
		return `rule ${stage1.rule}${context ? `: ${context}` : ""}`;
	}
	const top = Object.entries(stage2.contributions)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([name, value]) => `${name} ${value}`)
		.join(", ");
	const comparison = stage2.breached ? "≥" : "<";
	return `backstop score ${stage2.score} ${comparison} ${stage2.threshold}${top ? `: ${top}` : ""}`;
}
