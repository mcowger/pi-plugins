/**
 * Decisions-API classification for inline code evals.
 *
 * Sends extracted eval sources (see ./eval-detection.ts) to the OpenRouter
 * Decisions router, which answers capability/scope questions about the code.
 * A deterministic two-stage engine maps answers to a verdict:
 *
 *   Stage 1 — rule table over bucketed answers (decisive, explainable).
 *             The only stage that can produce "deny".
 *   Stage 2 — weighted-score backstop over raw probabilities, catching
 *             accumulated weak signals when no rule fired. Caps at "ask".
 *             Always computed (even when Stage 1 decided) so logs carry
 *             rule-verdict-vs-score pairs for future tuning.
 *
 * Plain `fetch` — no SDK. All network/auth/malformed failures throw
 * DecisionsError for the caller to map via config.errorAction.
 */

import { createHash } from "node:crypto";
import type { DecisionsConfig } from "../config.js";
import type { EvalSource } from "./eval-detection.js";

export type { DecisionsConfig } from "../config.js";

// ─── Wire types ───────────────────────────────────────────────────────────────

export interface DecisionsNoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true: string; false: string };
}

export interface DecisionsChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export type DecisionsQuestion = DecisionsNoulQuestion | DecisionsChoiceQuestion;

export interface DecisionsNoulAnswer {
	type: "noul";
	/** Probability that the answer is "true" (confirmed by spike 2026-09-22). */
	noul: number;
}

export interface DecisionsChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type DecisionsAnswer = DecisionsNoulAnswer | DecisionsChoiceAnswer;

export interface DecisionsUsage {
	cost?: number;
	input_tokens: number;
	output_tokens: number;
}

interface DecisionsResponse {
	id: string;
	model: string;
	provider: string;
	usage: DecisionsUsage;
	answers: Record<string, DecisionsAnswer>;
}

export type DecisionsErrorCode =
	| "auth"
	| "http"
	| "timeout"
	| "network"
	| "malformed";

export class DecisionsError extends Error {
	code: DecisionsErrorCode;
	detail: string;
	constructor(detail: string, code: DecisionsErrorCode = "network") {
		super(`[pi-controls] Decisions request failed: ${detail}`);
		this.name = "DecisionsError";
		this.code = code;
		this.detail = detail;
	}
}

// ─── State and questions ──────────────────────────────────────────────────────

export interface DecisionsState {
	language: string;
	interpreter: string;
	origin: string;
	command: string;
	pipeline: string;
	source: string;
	truncated: boolean;
	/** Attribution scope: judge `source` only; the rest is context. */
	scope: string;
	execution_context: {
		cwd: string;
		targets: string[];
	};
}

export const DESTRUCTIVE_QUESTION = "destructive";
export const NETWORK_QUESTION = "network";
export const EXEC_QUESTION = "exec";
export const INFERENCE_CALL_QUESTION = "inference_call";
export const WRITE_SCOPE_QUESTION = "write_scope";
export const READ_SCOPE_QUESTION = "read_scope";
export const OBFUSCATED_QUESTION = "obfuscated";

export function buildQuestions(): Record<string, DecisionsQuestion> {
	return {
		[DESTRUCTIVE_QUESTION]: {
			type: "noul",
			instructions:
				"Does this code destroy, delete, corrupt, or irreversibly alter data, or disrupt the system, services, or other processes?",
			criteria: {
				true: "Deletes files or directories (rm, unlink, rmtree, DROP TABLE), wipes or formats storage, kills or disrupts processes/services, revokes credentials or access, corrupts or encrypts data without a recovery path, fork bombs or resource exhaustion, or any other irreversible damage to data or availability. Rewriting a file in place with transformed content is modification, not destruction.",
				false:
					"Reads, displays, computes, or transmits data without deleting or damaging anything; creates new files or writes logs/backups without removing existing data; makes fully reversible changes — including `rm` of tracked files and edits confined to version-controlled working trees (recoverable via version control), backups, or other recoverable locations.",
			},
		},
		[NETWORK_QUESTION]: {
			type: "noul",
			instructions: "Does this code communicate over the network?",
			criteria: {
				true: "DNS lookups, HTTP/API requests, raw sockets, SSH/FTP, any inbound/outbound traffic; downloads remote code or data; uploads local data outward; shells out to network tools (curl, wget, ssh, scp, nc).",
				false:
					"Purely local computation and filesystem access. Merely containing a URL string without fetching it.",
			},
		},
		[EXEC_QUESTION]: {
			type: "noul",
			instructions:
				"Does this code execute other programs, shell commands, or dynamically generated code?",
			criteria: {
				true: "Subprocesses or shells (subprocess, os.system, child_process, Bun.spawn, backticks, $(…)); eval / exec / Function on dynamically built strings.",
				false:
					"Single process, library calls only, statically visible code. Importing and calling libraries is not execution.",
			},
		},
		[INFERENCE_CALL_QUESTION]: {
			type: "noul",
			instructions:
				"Does the surrounding command invoke AI model inference that spends tokens? Unlike the other questions, judge the whole pipeline: model endpoints plus any token budgets or prompts, wherever they appear.",
			criteria: {
				true: "Requests to model inference endpoints (/v1/responses, /v1/chat/completions, /v1/decisions, :generate, /inference, remote metered agentic coding runs) carrying model names with token budgets (max_tokens, max_output_tokens), prompts, or inputs — calls that consume metered tokens. Local test agents and localhost harnesses are not inference calls.",
				false:
					"Metadata, listing, management, usage-summary, or config endpoints (models list, aliases, providers, usage) even when authenticated; local model info; model names appearing without an inference call; no model invocation at all.",
			},
		},
		[WRITE_SCOPE_QUESTION]: {
			type: "choice",
			instructions:
				"What is the broadest lasting filesystem write this code performs? Judge paths against the cwd in execution_context. Temp files that are cleaned up do not count.",
			criteria: {
				none: "No lasting writes. A filter that reads stdin and prints to stdout performs no write.",
				temp: "Writes confined to ephemeral temp space (/tmp, mktemp, OS temp dirs) that the code itself created for transient use. Deleting or modifying files the code did not just create is not temp — classify by where those files live.",
				within:
					"Lasting writes under the cwd (project files, build outputs, local dotfiles).",
				outside:
					"Lasting writes outside the cwd that are not sensitive system locations.",
				sensitive_system:
					"Writes to OS directories (/etc, /usr, /bin), SSH/credential stores (~/.ssh, keychains), other users' files, device nodes, or scheduled-task / service definitions.",
				unknown:
					"Paths are constructed dynamically and cannot be resolved from the code, or the write target is indeterminable.",
			},
		},
		[READ_SCOPE_QUESTION]: {
			type: "choice",
			instructions:
				"What is the most sensitive data this code reads or transmits outward?",
			criteria: {
				none: "No reads beyond its own literal inputs, or no reads at all.",
				ordinary:
					"Ordinary project files, public data, piped stdin content, aggregate counters, the agent's own application config and settings files, or source code (even auth-related code — only credential values are sensitive). Fields merely named 'token', 'key', or 'secret' in ordinary API responses are ordinary. Code that strips or redacts secrets from transient data (API responses, debug dumps) before output is ordinary, as is printing an inventory (key names, counts, truncated previews) of data in hand — unless the source is a credential store.",
				sensitive:
					"Actual authentication credentials (private keys, ~/.ssh, *.pem, credential files like .env, secret env vars). READS OF STANDING CREDENTIAL STORES — files whose purpose is holding secrets (agent/provider configuration holding keys such as models.yml, config.yml, ~/.opencodereview/config.json, key files) — regardless of what the code prints. Shared system or daemon logs aggregating data across sessions, users, or tenants (which routinely embed secrets). Dumps proven secret-bearing by a sibling pipeline stage (e.g. another stage redacting or extracting secrets from the same file). Other users' or clients' private data, and data singling out a specific person, device, or client (e.g. filtering records to one MAC address, username, or device) — or transmission of local file contents to a remote destination. Code that specifically seeks out secret-named fields to use as credentials — extracting keys/tokens to authenticate, export, or transmit, especially with a dump-everything fallback — is sensitive.",
				unknown:
					"Read targets are constructed dynamically and sensitivity cannot be determined from the code.",
			},
		},
		[OBFUSCATED_QUESTION]: {
			type: "noul",
			instructions:
				"Is this code deliberately obfuscated, encoded, or structured to conceal what it does?",
			criteria: {
				true: "Base64/hex-encoded blobs decoded then executed, eval / exec of programmatically constructed strings, encrypted payloads, misleading names or dead code hiding behavior, multi-stage download-and-execute chains.",
				false:
					"Straightforward, readable code whose intent is clear. Normal use of encoding, compression, or minified libraries for data — without executing the decoded result. Eval/exec of a named file's contents, or other dynamically loaded but unconcealed code, is not obfuscation by itself (the exec question still applies) — concealment means hiding what runs.",
			},
		},
	};
}

const SCOPE_NOTE =
	"Judge ONLY the `source` field, with one exception noted below. `command`, " +
	"`pipeline`, and `execution_context` are context to help you understand " +
	"where the code runs — other pipeline stages may use the network, run " +
	"programs, or touch files on their own. None of that counts unless " +
	"`source` itself does it. A filter that reads stdin and prints to " +
	"stdout performs no network, execution, or filesystem action of its " +
	"own. EXCEPTION: the `inference_call` question is about the whole " +
	"pipeline — model endpoints, token budgets, and prompts anywhere in " +
	"`pipeline` or `command` count. And for `read_scope` only, the pipeline " +
	"may show " +
	"what data the code handles (e.g. stdin fed from a credentials " +
	"endpoint, or extracted values passed to auth headers downstream) — " +
	"use that solely to judge data sensitivity, never to attribute " +
	"actions to the code.";

function truncateBytes(
	text: string,
	maxBytes: number,
): {
	text: string;
	truncated: boolean;
} {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}
	return {
		text: Buffer.from(text, "utf8").slice(0, maxBytes).toString("utf8"),
		truncated: true,
	};
}

export function buildState(
	source: EvalSource,
	stageCommand: string,
	pipeline: string,
	cwd: string,
	targets: string[],
	maxSourceBytes: number,
): DecisionsState {
	const { text, truncated } = truncateBytes(source.source, maxSourceBytes);
	return {
		language: source.language,
		interpreter: source.interpreter,
		origin: source.origin,
		command: stageCommand,
		pipeline,
		source: text,
		truncated,
		scope: SCOPE_NOTE,
		execution_context: { cwd, targets },
	};
}

// ─── Buckets ──────────────────────────────────────────────────────────────────

export type NoulBucket = "yes" | "no" | "uncertain";

export interface AnswerBuckets {
	destructive: NoulBucket;
	network: NoulBucket;
	exec: NoulBucket;
	obfuscated: NoulBucket;
	/** The pipeline invokes token-spending model inference (ask on yes). */
	inference_call: NoulBucket;
	/** Choice top label, or "uncertain" when below the confidence threshold. */
	write_scope: string;
	/** Choice top label, or "uncertain" when below the confidence threshold. */
	read_scope: string;
}

function bucketNoul(
	p: number,
	yesThreshold: number,
	noThreshold: number,
): NoulBucket {
	if (p >= yesThreshold) return "yes";
	if (p <= noThreshold) return "no";
	return "uncertain";
}

function bucketChoice(
	answer: DecisionsChoiceAnswer,
	choiceConfidence: number,
	riskyMassThreshold: number,
	riskyLabels: Set<string>,
): string {
	const entries = Object.entries(answer.probabilities);
	if (entries.length === 0) return answer.choice;
	let top = answer.choice;
	let topProb = answer.probabilities[answer.choice] ?? -1;
	let riskyMass = 0;
	for (const [label, prob] of entries) {
		if (prob > topProb) {
			top = label;
			topProb = prob;
		}
		if (riskyLabels.has(label)) riskyMass += prob;
	}
	if (topProb >= choiceConfidence) return top;
	// Below confidence: only escalate when the probability mass leans risky.
	// Dithering between benign labels (ordinary/none) is noise, not signal.
	return riskyMass >= riskyMassThreshold ? "uncertain" : top;
}

function asNoul(name: string, answer: DecisionsAnswer): number {
	if (answer.type !== "noul" || typeof answer.noul !== "number") {
		throw new DecisionsError(
			`malformed answer for "${name}": expected a noul probability`,
			"malformed",
		);
	}
	return answer.noul;
}

function asChoice(
	name: string,
	answer: DecisionsAnswer,
): DecisionsChoiceAnswer {
	if (answer.type !== "choice" || typeof answer.choice !== "string") {
		throw new DecisionsError(
			`malformed answer for "${name}": expected a choice label`,
			"malformed",
		);
	}
	return answer;
}

export function bucketAnswers(
	answers: Record<string, DecisionsAnswer>,
	config: DecisionsConfig,
): { buckets: AnswerBuckets; probs: Record<string, number> } {
	for (const name of [
		DESTRUCTIVE_QUESTION,
		NETWORK_QUESTION,
		EXEC_QUESTION,
		INFERENCE_CALL_QUESTION,
		WRITE_SCOPE_QUESTION,
		READ_SCOPE_QUESTION,
		OBFUSCATED_QUESTION,
	]) {
		if (!answers[name]) {
			throw new DecisionsError(`missing answer for "${name}"`, "malformed");
		}
	}
	const probs: Record<string, number> = {
		[DESTRUCTIVE_QUESTION]: asNoul(
			DESTRUCTIVE_QUESTION,
			answers[DESTRUCTIVE_QUESTION],
		),
		[NETWORK_QUESTION]: asNoul(NETWORK_QUESTION, answers[NETWORK_QUESTION]),
		[EXEC_QUESTION]: asNoul(EXEC_QUESTION, answers[EXEC_QUESTION]),
		[INFERENCE_CALL_QUESTION]: asNoul(
			INFERENCE_CALL_QUESTION,
			answers[INFERENCE_CALL_QUESTION],
		),
		[OBFUSCATED_QUESTION]: asNoul(
			OBFUSCATED_QUESTION,
			answers[OBFUSCATED_QUESTION],
		),
	};
	const buckets: AnswerBuckets = {
		destructive: bucketNoul(
			probs[DESTRUCTIVE_QUESTION],
			config.yesThreshold,
			config.noThreshold,
		),
		network: bucketNoul(
			probs[NETWORK_QUESTION],
			config.yesThreshold,
			config.noThreshold,
		),
		exec: bucketNoul(
			probs[EXEC_QUESTION],
			config.yesThreshold,
			config.noThreshold,
		),
		obfuscated: bucketNoul(
			probs[OBFUSCATED_QUESTION],
			config.yesThreshold,
			config.noThreshold,
		),
		inference_call: bucketNoul(
			probs[INFERENCE_CALL_QUESTION],
			config.yesThreshold,
			config.noThreshold,
		),
		write_scope: bucketChoice(
			asChoice(WRITE_SCOPE_QUESTION, answers[WRITE_SCOPE_QUESTION]),
			config.choiceConfidence,
			config.riskyMassThreshold,
			WRITE_RISKY_LABELS,
		),
		read_scope: bucketChoice(
			asChoice(READ_SCOPE_QUESTION, answers[READ_SCOPE_QUESTION]),
			config.choiceConfidence,
			config.riskyMassThreshold,
			READ_RISKY_LABELS,
		),
	};
	return { buckets, probs };
}

// ─── Stage 1: rule table ──────────────────────────────────────────────────────

export interface Stage1Result {
	verdict: "deny" | "ask" | null;
	rule: string | null;
}

const WRITE_OUT_OF_SCOPE = new Set(["outside", "sensitive_system", "unknown"]);
const READ_SENSITIVE = new Set(["sensitive", "unknown"]);

/** Labels carrying escalation mass for the risky-mass bucket rule. */
const WRITE_RISKY_LABELS = new Set(WRITE_OUT_OF_SCOPE);
const READ_RISKY_LABELS = new Set(READ_SENSITIVE);

function rule(verdict: "deny" | "ask", id: string): Stage1Result {
	return { verdict, rule: id };
}

/** First match wins — deny rules before ask rules. */
export function applyStage1(buckets: AnswerBuckets): Stage1Result {
	const writeOut =
		WRITE_OUT_OF_SCOPE.has(buckets.write_scope) ||
		buckets.write_scope === "uncertain";
	const readSens =
		READ_SENSITIVE.has(buckets.read_scope) ||
		buckets.read_scope === "uncertain";

	if (
		buckets.destructive === "yes" &&
		(buckets.obfuscated === "yes" ||
			buckets.write_scope === "outside" ||
			buckets.write_scope === "sensitive_system")
	) {
		return rule("deny", "destructive-concealed-or-outside");
	}
	if (buckets.read_scope === "sensitive" && buckets.network === "yes") {
		return rule("deny", "exfil-shape");
	}
	if (
		buckets.obfuscated === "yes" &&
		(buckets.network === "yes" || buckets.exec === "yes")
	) {
		return rule("deny", "concealed-capability");
	}
	if (buckets.destructive === "yes") {
		return rule("ask", "destructive-in-scope");
	}
	if (writeOut) {
		return rule("ask", "write-out-of-scope");
	}
	if (readSens) {
		return rule("ask", "sensitive-read");
	}
	if (buckets.obfuscated === "yes") {
		return rule("ask", "obfuscated-alone");
	}
	if (
		buckets.destructive === "uncertain" ||
		buckets.obfuscated === "uncertain" ||
		buckets.write_scope === "uncertain" ||
		buckets.read_scope === "uncertain"
	) {
		return rule("ask", "uncertain-critical");
	}
	// Token-spending model inference asks on its own. Uncertain stays quiet
	// (a model name without an inference call is not evidence).
	if (buckets.inference_call === "yes") {
		return rule("ask", "inference-call");
	}
	return { verdict: null, rule: null };
}

// ─── Stage 2: score backstop ──────────────────────────────────────────────────

export interface BackstopResult {
	score: number;
	threshold: number;
	breached: boolean;
	contributions: Record<string, number>;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

/**
 * Weighted sum over raw probabilities. Never denies — returns whether the
 * ask threshold was breached, with per-signal contributions for the log.
 */
export function scoreBackstop(
	probs: Record<string, number>,
	choiceProbs: {
		write_scope: Record<string, number>;
		read_scope: Record<string, number>;
	},
	config: DecisionsConfig,
): BackstopResult {
	const w = config.weights;
	const raw: Record<string, number> = {
		destructive: probs[DESTRUCTIVE_QUESTION] * w.destructive,
		obfuscated: probs[OBFUSCATED_QUESTION] * w.obfuscated,
		network: probs[NETWORK_QUESTION] * w.network,
		exec: probs[EXEC_QUESTION] * w.exec,
		inferenceCall: (probs[INFERENCE_CALL_QUESTION] ?? 0) * w.inferenceCall,
		writeSensitive:
			(choiceProbs.write_scope.sensitive_system ?? 0) * w.writeSensitive,
		writeOutside: (choiceProbs.write_scope.outside ?? 0) * w.writeOutside,
		writeUnknown: (choiceProbs.write_scope.unknown ?? 0) * w.writeUnknown,
		readSensitive: (choiceProbs.read_scope.sensitive ?? 0) * w.readSensitive,
		readUnknown: (choiceProbs.read_scope.unknown ?? 0) * w.readUnknown,
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

let sessionId: string | null = null;

function getSessionId(): string {
	sessionId ??= `pi-controls-${process.pid}-${Date.now()}`;
	return sessionId;
}

function validateResponse(body: unknown): DecisionsResponse {
	if (!body || typeof body !== "object") {
		throw new DecisionsError("response is not a JSON object", "malformed");
	}
	const response = body as Partial<DecisionsResponse>;
	if (!response.answers || typeof response.answers !== "object") {
		throw new DecisionsError("response has no answers object", "malformed");
	}
	if (
		!response.usage ||
		typeof response.usage.input_tokens !== "number" ||
		typeof response.usage.output_tokens !== "number"
	) {
		throw new DecisionsError("response has no valid usage object", "malformed");
	}
	return {
		id: typeof response.id === "string" ? response.id : "",
		model: typeof response.model === "string" ? response.model : "",
		provider: typeof response.provider === "string" ? response.provider : "",
		usage: response.usage,
		answers: response.answers,
	};
}

export interface ClassifyInput {
	source: EvalSource;
	/** Reconstructed stage argv (flag context). */
	stageCommand: string;
	/** Full original bash command (data-flow context). */
	pipeline: string;
	cwd: string;
	targets: string[];
}

export interface SourceVerdict {
	verdict: "allow" | "ask" | "deny";
	buckets: AnswerBuckets;
	stage1: Stage1Result;
	stage2: BackstopResult;
	request: {
		url: string;
		model: string;
		state: DecisionsState;
		questions: Record<string, DecisionsQuestion>;
	};
	response: DecisionsResponse;
	latencyMs: number;
}

export async function classifySource(
	input: ClassifyInput,
	config: DecisionsConfig,
): Promise<SourceVerdict> {
	const token = process.env[config.tokenEnv];
	if (!token) {
		throw new DecisionsError(
			`auth token env var "${config.tokenEnv}" is not set`,
			"auth",
		);
	}
	const state = buildState(
		input.source,
		input.stageCommand,
		input.pipeline,
		input.cwd,
		input.targets,
		config.maxSourceBytes,
	);
	const questions = buildQuestions();
	const started = Date.now();
	let res: Response;
	try {
		res = await fetch(config.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"X-Title": "pi-controls",
			},
			body: JSON.stringify({
				model: config.model,
				state,
				questions,
				session_id: getSessionId(),
			}),
			signal: AbortSignal.timeout(config.timeoutMs),
		});
	} catch (error) {
		const code =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "network";
		const reason =
			code === "timeout"
				? `timeout after ${config.timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error);
		throw new DecisionsError(reason, code);
	}
	if (!res.ok) {
		throw new DecisionsError(
			`HTTP ${res.status} from ${config.url}`,
			res.status === 401 || res.status === 403 ? "auth" : "http",
		);
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new DecisionsError("response is not valid JSON", "malformed");
	}
	const latencyMs = Date.now() - started;
	const response = validateResponse(body);
	const { buckets, probs } = bucketAnswers(response.answers, config);
	const stage1 = applyStage1(buckets);
	// The backstop is always computed so logs carry rule-vs-score pairs for tuning.
	const stage2 = scoreBackstop(
		probs,
		{
			write_scope:
				asChoice(WRITE_SCOPE_QUESTION, response.answers[WRITE_SCOPE_QUESTION])
					.probabilities ?? {},
			read_scope:
				asChoice(READ_SCOPE_QUESTION, response.answers[READ_SCOPE_QUESTION])
					.probabilities ?? {},
		},
		config,
	);
	const verdict = stage1.verdict ?? (stage2.breached ? "ask" : "allow");
	return {
		verdict,
		buckets,
		stage1,
		stage2,
		request: { url: config.url, model: config.model, state, questions },
		response,
		latencyMs,
	};
}

// ─── Session verdict cache ────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 200;
const verdictCache = new Map<string, "allow" | "ask" | "deny">();

export function evalCacheKey(language: string, source: string): string {
	return `sha256:${createHash("sha256").update(`${language}\0${source}`, "utf8").digest("hex")}`;
}

export function getCachedVerdict(
	key: string,
): "allow" | "ask" | "deny" | undefined {
	return verdictCache.get(key);
}

export function setCachedVerdict(
	key: string,
	verdict: "allow" | "ask" | "deny",
): void {
	if (!verdictCache.has(key) && verdictCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = verdictCache.keys().next();
		if (!oldest.done) verdictCache.delete(oldest.value);
	}
	verdictCache.set(key, verdict);
}

/** Exported for tests. */
export function clearEvalCache(): void {
	verdictCache.clear();
}

// ─── Rationale for user-facing messages ───────────────────────────────────────

/** Buckets worth citing: noul yes/uncertain, and non-benign scope labels. */
export function activeBuckets(buckets: AnswerBuckets): string[] {
	const active: string[] = [];
	for (const name of [
		"destructive",
		"network",
		"exec",
		"obfuscated",
		"inference_call",
	] as const) {
		if (buckets[name] !== "no") active.push(`${name}=${buckets[name]}`);
	}
	if (!["none", "temp", "within"].includes(buckets.write_scope)) {
		active.push(`write_scope=${buckets.write_scope}`);
	}
	if (!["none", "ordinary"].includes(buckets.read_scope)) {
		active.push(`read_scope=${buckets.read_scope}`);
	}
	return active;
}

export function verdictRationale(
	verdictResult: Pick<SourceVerdict, "buckets" | "stage1" | "stage2">,
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
	return `backstop score ${stage2.score} ≥ ${stage2.threshold}${top ? `: ${top}` : ""}`;
}
