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
import { type LocalScope, resolveScope, type ScopeSource } from "./scope.js";
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

/**
 * `within` must be decided against the labelled targets: left to raw text, the
 * model scores a cwd written out as a long absolute path as `outside` or
 * `sensitive_system`, which escalates routine in-project calls.
 */
const SCOPE_WITHIN_CRITERIA =
	"The call's effect lands on `cwd` itself or anywhere beneath it, including " +
	"when written as a long absolute path — `cd /home/me/proj && git status` " +
	"with cwd `/home/me/proj` is `within`. Trust the labels in `targets`: every " +
	"entry labelled `within` is inside the project. Relative filenames with no " +
	"path prefix resolve under the cwd.";

const SCOPE_OUTSIDE_CRITERIA =
	"Resolved outside the cwd and not a sensitive system location: another " +
	"project, home miscellany (dotfiles, agent logs, caches), or files kept under " +
	"/tmp that the call did not just create.";

const SCOPE_SENSITIVE_SYSTEM_CRITERIA =
	"OS directories (/etc, /usr, /bin, /sbin), credential stores (~/.ssh, " +
	"keychains, .aws, .env, key files), other users' files, or system service " +
	"and scheduled-task definitions. A path is NOT sensitive merely because it " +
	"sits under a dot-directory or because it is an agent's own log or " +
	"non-credential config file — those are `outside`.";

const DATA_ORDINARY_CRITERIA =
	"Project files, public data, source code (even auth-related code), build " +
	"configs, aggregate counters, fields merely named 'token', 'key', or " +
	"'secret' in ordinary data, redacted or aggregated output, and operational " +
	"records the agent's own tooling writes about itself: an audit or session " +
	"log, a harness log, or non-credential tool configuration that embeds no " +
	"tokens or secrets — e.g. `~/.pi/agent/extensions/pi-controls.log`, " +
	"`~/.pi/agent/sessions/*`, `pi-controls.jsonc`, `settings.json`. Reading " +
	"such a file to debug a plugin or agent is ordinary work, not a secret " +
	"read. A file is not sensitive merely because it sits under a " +
	"dot-directory, lives in a tool's config directory, records commands or " +
	"verdicts, or has a `.log`/`.jsonl` name.";

const DATA_SENSITIVE_CRITERIA =
	"Actual credentials (private keys, ~/.ssh, *.pem, .env, token stores such " +
	"as auth.json, .aws/credentials, models.yml), reading the value of a secret " +
	"environment variable (e.g. `echo $API_KEY`, a `$TOKEN` in an Authorization " +
	"header), a configuration file that embeds API keys or MCP credentials, " +
	"OS-level or shared daemon logs (`/var/log/auth.log`, journald), other " +
	"users' or clients' private data, data singling out a specific person, " +
	"device, or client, or local secret data transmitted to a remote " +
	"destination. The distinction from `ordinary` is the file's content, not " +
	"its location: a credential store stays sensitive even when it sits beside " +
	"an ordinary log, while an agent's own log stays ordinary.";

function defaultQuestions(): Record<string, DecisionsQuestion> {
	return {
		[AUTO_ACTION_CLASS_QUESTION]: {
			type: "choice",
			instructions: "What is the primary effect of this call?",
			criteria: {
				none: "No side effects: inspection, metadata, read-only query (e.g. echo, pwd, which).",
				local_read:
					"Reads local filesystem data that is already present (e.g. cat, grep, find, ls, the read tool).",
				local_write:
					"Creates, modifies, or deletes local files or local state (e.g. touch, cp, sed -i, rm, git checkout, the write/edit tools).",
				process_exec:
					"Executes a program, background daemon, dynamic script, or inline code.",
				remote_read:
					"Fetches data from a remote system without changing it (e.g. curl GET, git fetch).",
				remote_write:
					"Changes state on a remote system (e.g. git push, PR/merge, curl POST/PUT, a posted API change, publishing packages).",
				unknown: "The effect cannot be determined from the call.",
			},
		},
		[AUTO_SCOPE_QUESTION]: {
			type: "choice",
			instructions:
				"Relative to the cwd, where does the call's effect land? Read `targets` for each path already resolved and labelled.",
			criteria: {
				within: SCOPE_WITHIN_CRITERIA,
				temporary:
					"Ephemeral temp space (/tmp, mktemp, OS temp dirs) used transiently by the call: created by it, or cleaned up as part of it. Deleting or modifying files the call did not just create is not temporary — classify by where those files live.",
				outside: SCOPE_OUTSIDE_CRITERIA,
				sensitive_system: SCOPE_SENSITIVE_SYSTEM_CRITERIA,
				remote: "A remote system (no local path affected).",
				not_applicable: "No filesystem or remote target affected.",
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
				ordinary: DATA_ORDINARY_CRITERIA,
				sensitive: DATA_SENSITIVE_CRITERIA,
				unknown:
					"Read targets are constructed dynamically and sensitivity cannot be determined.",
			},
		},
		[AUTO_DESTRUCTIVE_QUESTION]: {
			type: "noul",
			instructions:
				"Does this call destroy or irreversibly alter data, or disrupt systems, services, or processes?",
			criteria: {
				true: "Deletes files or directories (rm, unlink, rmtree, DROP TABLE), wipes or formats storage, kills or disrupts processes/services (kill, pkill, systemctl stop), revokes credentials, makes an unrecoverable overwrite, fork bombs or resource exhaustion.",
				false:
					"Reads, creates new files, additive changes, or fully reversible changes — including deletes and edits confined to version-controlled working trees, backups, or scratch space.",
			},
		},
		[AUTO_NETWORK_QUESTION]: {
			type: "noul",
			instructions: "Does this call communicate with a remote system?",
			criteria: {
				true: "HTTP/API requests, DNS lookups, sockets, SSH/FTP, git fetch/push/clone, package installs (npm, pip, bun install), curl/wget, MCP calls to remote servers.",
				false:
					"Purely local work. Merely printing or naming a URL string without fetching it.",
			},
		},
		[AUTO_CONCEALED_QUESTION]: {
			type: "noul",
			instructions:
				"Is this call deliberately obfuscated or structured to conceal its effect?",
			criteria: {
				true: "Base64/hex blobs decoded then executed (e.g. echo … | base64 -d | sh), eval/exec of constructed strings, encrypted payloads, download-and-execute chains (curl … | bash), misleading names or dead code hiding behavior.",
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
	| "thresholds"
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
		thresholds: auto.thresholds,
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
	localScope?: LocalScope,
): {
	buckets: AutoBuckets;
	probs: AutoProbabilities;
	scopeSource: ScopeSource;
} {
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
	const t = config.thresholds;
	const scope = resolveScope(
		bucketChoice(
			scopeAnswer,
			t.scope.confidence,
			t.scope.riskyMass,
			SCOPE_RISKY_LABELS,
		),
		localScope,
	);
	const buckets: AutoBuckets = {
		action_class: bucketChoice(
			actionAnswer,
			t.action_class.confidence,
			t.action_class.riskyMass,
			ACTION_RISKY_LABELS,
		),
		scope: scope.scope,
		data_sensitivity: bucketChoice(
			dataAnswer,
			t.data_sensitivity.confidence,
			t.data_sensitivity.riskyMass,
			DATA_RISKY_LABELS,
		),
		destructive: bucketNoul(
			probs.destructive,
			t.destructive.yes,
			t.destructive.no,
		),
		network: bucketNoul(probs.network, t.network.yes, t.network.no),
		concealed: bucketNoul(probs.concealed, t.concealed.yes, t.concealed.no),
		inference_call: bucketNoul(
			probs.inference_call,
			t.inference_call.yes,
			t.inference_call.no,
		),
	};
	// A scope the plugin resolved itself is a fact, not a distribution: carry
	// the single label so the backstop cannot hedge over it.
	if (scope.source !== "model") probs.scope = { [scope.scope]: 1 };
	return { buckets, probs, scopeSource: scope.source };
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
		// Exfiltration needs an action that moves data off the machine. A local
		// write that merely mentions a credential falls through to the
		// sensitive-read ask. `process_exec` alone is too weak (the model labels
		// code-shaped writes that way), so it counts only when the call also
		// touches a credential store or system location.
		const transmits =
			actionClass === "remote_write" ||
			(actionClass === "process_exec" && scope === "sensitive_system");
		if (data === "sensitive" && buckets.network === "yes" && transmits) {
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
	/** What the caller resolved about the call's local paths, if anything. */
	localScope?: LocalScope;
}

export interface AutoVerdict {
	verdict: Verdict;
	buckets: AutoBuckets;
	/** Raw probabilities behind the buckets (scope collapsed when resolved locally). */
	probabilities: AutoProbabilities;
	scopeSource: ScopeSource;
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
	const { buckets, probs, scopeSource } = bucketAnswers(
		response.answers,
		auto,
		{
			action_class: choiceLabels(questions[AUTO_ACTION_CLASS_QUESTION]),
			scope: choiceLabels(questions[AUTO_SCOPE_QUESTION]),
			data_sensitivity: choiceLabels(questions[AUTO_DATA_SENSITIVITY_QUESTION]),
		},
		input.localScope,
	);
	const stage1 = applyStage1(buckets, auto.deny);
	const stage2 = scoreBackstop(probs, auto);
	const verdict: Verdict =
		stage1.verdict ?? (stage2.breached ? "ask" : "allow");
	return {
		verdict,
		buckets,
		probabilities: probs,
		scopeSource,
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

/** A cached auto verdict keeps its explanation so a repeat prompt still says why. */
export interface CachedAutoVerdict {
	verdict: Verdict;
	explanation: string;
}

const autoVerdictCache = createVerdictCache<CachedAutoVerdict>();

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

export function getCachedAutoVerdict(
	key: string,
): CachedAutoVerdict | undefined {
	return autoVerdictCache.get(key);
}

export function setCachedAutoVerdict(
	key: string,
	cached: CachedAutoVerdict,
): void {
	autoVerdictCache.set(key, cached);
}

/** Exported for tests and config reloads. */
export function clearAutoCache(): void {
	autoVerdictCache.clear();
}
