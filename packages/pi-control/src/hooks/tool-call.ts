import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ControlsMode } from "../index.js";
import {
	addApprovalRule,
	type ControlsResolvedConfig,
	type Action,
	type Rule,
} from "../config.js";
import { resolvePolicy } from "../utils/location.js";
import {
	matchCommand,
	matchRuleWithDetails,
	mostRestrictive,
} from "../utils/matching.js";
import { canonicalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";
import { promptSelect } from "../utils/forwarding.js";
import { logDecision } from "../utils/logger.js";
import { minimatch } from "minimatch";
import { basename } from "node:path";
import { DenyTracker } from "../utils/deny-tracker.js";
import { suggestSessionPattern } from "../utils/bash-arity.js";
import type { CommandStage } from "../utils/bash-ast.js";
import { detectEvalSources, type EvalSource } from "../utils/eval-detection.js";
import {
	DecisionsError,
	classifySource,
	evalCacheKey,
	getCachedVerdict,
	setCachedVerdict,
	verdictRationale,
} from "../utils/decisions.js";
import {
	appliedAutoConfig,
	autoCacheKey,
	classifyAuto,
	getCachedAutoVerdict,
	setCachedAutoVerdict,
} from "../utils/auto-decisions.js";
import { describeAutoVerdict } from "../utils/auto-explain.js";
import { buildAutoState } from "../utils/auto-state.js";
import type { AutoVerdictSink } from "../utils/auto-transcript.js";
import { type LocalScope, localScopeFromTargets } from "../utils/scope.js";
import type { AutoSkipReason, AutoTrace, EvalTrace } from "../utils/logger.js";

/**
 * Nudge messages pending injection into tool results, keyed by toolCallId.
 * Populated during tool_call handling; consumed during tool_result handling.
 */
export const pendingNudges = new Map<string, string>();

/**
 * Session-scoped allowlist for "Allow for session" choices.
 * When a user selects "Allow for session" during an ask prompt, the key
 * is stored here. Subsequent matching tool calls skip the ask and are
 * allowed automatically for the remainder of the session.
 *
 * Key format:
 *   non-bash: `toolName:paths`
 *   bash: `bash:pattern:paths` (pattern from arity-based suggestion)
 * where paths is sorted and pipe-joined.
 */
export const sessionAllows = new Set<string>();

/**
 * Build the canonical key for the session allowlist.
 *
 * For bash commands, the pattern is derived from the arity-based session
 * suggestion (e.g. `git commit *` for `git commit -m "msg"`) so that
 * similar subcommands match without re-prompting.
 */
export function sessionAllowKey(
	toolName: string,
	command: string | null,
	deniedPaths: string[],
	matchedPattern?: string,
): string {
	const paths =
		deniedPaths.length > 0 ? [...deniedPaths].sort().join("|") : "__cwd__";
	if (toolName === "bash" && command) {
		const pattern = suggestSessionPattern(command);
		return `bash:${pattern}:${paths}`;
	}
	return `${toolName}:${paths}`;
}

/**
 * Check whether a bash command matches any session-allow pattern.
 *
 * Session-allow keys for bash store arity-based patterns (e.g. `git commit *`).
 * We iterate the session-allow set and match the command against each
 * bash-prefixed key's pattern component.
 */
export function sessionAllowsBashMatches(
	command: string,
	paths: string[],
): boolean {
	const sorted = paths.length > 0 ? [...paths].sort().join("|") : "__cwd__";
	for (const key of sessionAllows) {
		if (!key.startsWith("bash:")) continue;
		// Key format: bash:<pattern>:<paths>
		const lastColon = key.lastIndexOf(":");
		const keyPaths = key.slice(lastColon + 1);
		if (keyPaths !== sorted) continue;
		const pattern = key.slice(5, lastColon); // strip "bash:" prefix
		if (matchCommand(pattern, command)) return true;
	}
	return false;
}

/**
 * Sliding-window deny counter for the agentTimeout circuit breaker.
 * Exported so tests can reset it between runs.
 */
export const denyTracker = new DenyTracker();

/**
 * Per-rule sliding-window nudge counters for the nudgeTimeout circuit breaker.
 * Keyed by "tool:pattern" (pattern omitted for non-bash rules). Exported so
 * tests can inspect and reset individual counters between runs.
 */
export const nudgeTrackers = new Map<string, DenyTracker>();

/** Return (creating if absent) the nudge tracker for a given rule key. */
function getNudgeTracker(key: string): DenyTracker {
	let tracker = nudgeTrackers.get(key);
	if (!tracker) {
		tracker = new DenyTracker();
		nudgeTrackers.set(key, tracker);
	}
	return tracker;
}

/**
 * Build the canonical key used to track nudge counts for a rule.
 * tool:pattern — pattern omitted for tool-level (non-bash) rules.
 */
export function nudgeKey(tool: string, pattern?: string): string {
	return pattern !== undefined ? `${tool}:${pattern}` : tool;
}

/** One eval-derived contribution to the final bash verdict. */
interface EvalOutcome {
	action: "allow" | "ask" | "deny";
	note: string;
	trace: EvalTrace;
}

/** Warn once per session when eval classification auth fails. */
let decisionsAuthWarned = false;

/** Warn once per session when the auto action has no decisions block to use. */
let autoUnavailableWarned = false;

/** Test hook: clear the once-per-session warnings. */
export function resetDecisionWarnings(): void {
	decisionsAuthWarned = false;
	autoUnavailableWarned = false;
}

/** argv[0] label for an eval trace ("unknown" when dynamic). */
function stageInterpreterLabel(stage: CommandStage): string {
	const first = stage.args[0];
	if (!first?.static) return "unknown";
	return basename(first.value).toLowerCase() || "unknown";
}

/**
 * File-dumping commands whose stdout legitimately feeds a downstream pipeline
 * stage (e.g. `cat package.json | python3 -c ...`).
 *
 * A nudge toward the read tool does not apply there — the read tool returns
 * content to the agent, it cannot feed the next stage's stdin.
 */
const PIPE_FEED_EXEMPT = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"strings",
	"xxd",
	"od",
	"tac",
	"nl",
]);

/** True when the stage is a file-dump command feeding a pipeline. */
function stageFeedsPipe(stage: CommandStage): boolean {
	const first = stage.args[0];
	if (!first?.static) return false;
	return PIPE_FEED_EXEMPT.has(basename(first.value).toLowerCase());
}

/**
 * Classify inline eval sources in bash stages via the Decisions API.
 *
 * Returns one outcome per source (plus one per unrecoverable/error case).
 * Skips the API entirely — recording the reason — when the feature is off,
 * no evals are present, or the command already carries an explicit approval.
 */
async function classifyEvalSources(
	ctx: ExtensionContext,
	stages: CommandStage[],
	pipeline: string,
	cwd: string,
	targets: string[],
	config: ControlsResolvedConfig,
	approvalAllowed: boolean,
	sessionAllowed: boolean,
): Promise<{
	outcomes: EvalOutcome[];
	skipped?: "session-allow" | "approval-rule";
	/** Stage indices whose inline eval source was actually classified. */
	classifiedStages: Set<number>;
}> {
	const decisions = config.decisions;
	if (!decisions) {
		return { outcomes: [], classifiedStages: new Set<number>() };
	}

	const found: {
		source: EvalSource;
		stageCommand: string;
		stageIndex: number;
	}[] = [];
	const missing: { interpreter: string; detail: string }[] = [];
	for (const [stageIndex, stage] of stages.entries()) {
		const detection = detectEvalSources(stage);
		for (const source of detection.sources) {
			found.push({ source, stageCommand: stage.command, stageIndex });
		}
		const label = stageInterpreterLabel(stage);
		for (const detail of detection.unavailable) {
			missing.push({ interpreter: label, detail });
		}
	}
	if (found.length === 0 && missing.length === 0) {
		return { outcomes: [], classifiedStages: new Set<number>() };
	}
	if (sessionAllowed) {
		return {
			outcomes: [],
			skipped: "session-allow",
			classifiedStages: new Set<number>(),
		};
	}
	if (approvalAllowed) {
		return {
			outcomes: [],
			skipped: "approval-rule",
			classifiedStages: new Set<number>(),
		};
	}

	const outcomes: EvalOutcome[] = [];
	const classifiedStages = new Set<number>();
	for (const { interpreter, detail } of missing) {
		const action = decisions.unavailableAction;
		outcomes.push({
			action,
			note: detail,
			trace: { kind: "unavailable", interpreter, detail, action },
		});
	}
	const classified = await Promise.all(
		found.map(
			async ({ source, stageCommand, stageIndex }): Promise<EvalOutcome> => {
				const key = evalCacheKey(source.language, source.source);
				const cached = getCachedVerdict(key);
				if (cached !== undefined) {
					classifiedStages.add(stageIndex);
					return {
						action: cached,
						note: `cached: ${cached}`,
						trace: { kind: "cached", key, verdict: cached },
					};
				}
				const started = Date.now();
				try {
					const result = await classifySource(
						{ source, stageCommand, pipeline, cwd, targets },
						decisions,
					);
					setCachedVerdict(key, result.verdict);
					classifiedStages.add(stageIndex);
					return {
						action: result.verdict,
						note: verdictRationale(result),
						trace: {
							kind: "classified",
							language: source.language,
							interpreter: source.interpreter,
							origin: source.origin,
							truncated: result.request.state.truncated,
							request: result.request,
							response: result.response,
							evaluation: {
								buckets: result.buckets,
								appliedConfig: {
									yesThreshold: decisions.yesThreshold,
									noThreshold: decisions.noThreshold,
									choiceConfidence: decisions.choiceConfidence,
									riskyMassThreshold: decisions.riskyMassThreshold,
									backstopThreshold: decisions.backstopThreshold,
									weights: decisions.weights,
								},
								stage1: result.stage1,
								stage2: result.stage2,
								verdict: result.verdict,
							},
							latencyMs: result.latencyMs,
						},
					};
				} catch (error) {
					const detail =
						error instanceof DecisionsError ? error.detail : String(error);
					if (
						error instanceof DecisionsError &&
						error.code === "auth" &&
						!decisionsAuthWarned
					) {
						decisionsAuthWarned = true;
						ctx.ui.notify(
							`[pi-controls] eval classification auth failed: ${detail}`,
							"warning",
						);
					}
					const action = decisions.errorAction;
					return {
						action,
						note: detail,
						trace: {
							kind: "error",
							interpreter: source.interpreter,
							detail,
							action,
							latencyMs: Date.now() - started,
						},
					};
				}
			},
		),
	);
	outcomes.push(...classified);
	return { outcomes, classifiedStages };
}

/** Result of resolving a combined `auto` action to a concrete verdict. */
interface AutoOutcome {
	action: "allow" | "ask" | "deny";
	/** Pre-labelled rationale ("auto: …") for the ask/deny message. */
	note?: string;
	trace?: AutoTrace;
	skipped?: AutoSkipReason;
}

/**
 * Resolve a tool call whose combined action is `auto` to a concrete verdict.
 *
 * Guards (no API call): eval already classified, session allowlist, or
 * decisions unconfigured. A saved approval rule needs no guard here — it
 * contributes an explicit `allow` for its target during matching, so the call
 * only reaches `auto` when some target is not approved. Otherwise the state is
 * assembled, answered against the session verdict cache, or classified via the
 * Decisions API. Never throws — API failures map through
 * `decisions.errorAction`.
 */
async function resolveAutoAction(args: {
	ctx: ExtensionContext;
	config: ControlsResolvedConfig;
	toolName: string;
	input: Record<string, unknown>;
	targets: string[];
	localScope?: LocalScope;
	sessionAllowed: boolean;
	evalClassified: boolean;
	toolInfo?: ToolInfo;
	onAutoVerdict?: AutoVerdictSink;
}): Promise<AutoOutcome> {
	const {
		ctx,
		config,
		toolName,
		input,
		targets,
		localScope,
		sessionAllowed,
		evalClassified,
		toolInfo,
		onAutoVerdict,
	} = args;

	if (evalClassified) return { action: "allow", skipped: "eval-classified" };
	if (sessionAllowed) return { action: "allow", skipped: "session-allow" };

	const decisions = config.decisions;
	if (!decisions) {
		if (!autoUnavailableWarned) {
			autoUnavailableWarned = true;
			ctx.ui.notify(
				"[pi-controls] auto action needs a `decisions` block in config — falling back to ask",
				"warning",
			);
		}
		return {
			action: "ask",
			note: "auto: decisions API not configured",
			trace: {
				kind: "auto-unavailable",
				detail: "decisions block not configured",
				action: "ask",
			},
		};
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const key = autoCacheKey({
		tool: toolName,
		rawInput: input,
		targets,
		cwd: ctx.cwd,
		sessionId,
	});
	const cached = getCachedAutoVerdict(key);
	if (cached !== undefined) {
		return {
			action: cached.verdict,
			note: `auto (cached): ${cached.explanation}`,
			trace: { kind: "auto-cached", key, verdict: cached.verdict },
		};
	}

	// Build the (conversation-reading, input-normalizing) state only on a miss.
	const state = buildAutoState({
		toolName,
		input,
		cwd: ctx.cwd,
		targets,
		sessionId,
		sessionManager: ctx.sessionManager,
		toolInfo,
		auto: decisions.auto,
	});

	const started = Date.now();
	try {
		const result = await classifyAuto(
			{ state, sessionId, localScope },
			decisions,
		);
		const explanation = describeAutoVerdict(result, state.targets);
		setCachedAutoVerdict(key, { verdict: result.verdict, explanation });
		if (
			decisions.auto.transcript &&
			(result.verdict === "allow" || result.verdict === "deny")
		) {
			onAutoVerdict?.({
				tool: toolName,
				command:
					toolName === "bash" && typeof input.command === "string"
						? input.command
						: null,
				verdict: result.verdict,
				explanation,
				targets,
			});
		}
		return {
			action: result.verdict,
			note: `auto: ${explanation}`,
			trace: {
				kind: "auto-classified",
				request: result.request,
				response: result.response,
				evaluation: {
					buckets: result.buckets,
					scopeSource: result.scopeSource,
					appliedConfig: appliedAutoConfig(decisions.auto),
					stage1: result.stage1,
					stage2: result.stage2,
					verdict: result.verdict,
				},
				latencyMs: result.latencyMs,
			},
		};
	} catch (error) {
		const detail =
			error instanceof DecisionsError ? error.detail : String(error);
		if (
			error instanceof DecisionsError &&
			error.code === "auth" &&
			!decisionsAuthWarned
		) {
			decisionsAuthWarned = true;
			ctx.ui.notify(
				`[pi-controls] decisions auth failed: ${detail}`,
				"warning",
			);
		}
		// `deny: false` promises the engine can never deny — cap the error path too.
		const configured = decisions.errorAction;
		const action =
			!decisions.auto.deny && configured === "deny" ? "ask" : configured;
		return {
			action,
			note: `auto: ${detail}`,
			trace: {
				kind: "auto-error",
				detail,
				action,
				latencyMs: Date.now() - started,
			},
		};
	}
}

/** Concrete outcome of resolving a combined action. */
interface CombinedResolution {
	finalAction: Action;
	autoNote?: string;
	autoTrace?: AutoTrace;
	autoSkipped?: AutoSkipReason;
}

/**
 * Resolve a combined action to a concrete outcome. Non-`auto` actions pass
 * through unchanged; `auto` is delegated to the Decisions evaluation.
 */
async function resolveCombinedAction(args: {
	combinedAction: Action;
	ctx: ExtensionContext;
	config: ControlsResolvedConfig;
	toolName: string;
	input: Record<string, unknown>;
	targets: string[];
	localScope?: LocalScope;
	sessionAllowed: boolean;
	evalClassified: boolean;
	toolInfo?: ToolInfo;
	onAutoVerdict?: AutoVerdictSink;
}): Promise<CombinedResolution> {
	if (args.combinedAction !== "auto") {
		return { finalAction: args.combinedAction };
	}
	const outcome = await resolveAutoAction({
		ctx: args.ctx,
		config: args.config,
		toolName: args.toolName,
		input: args.input,
		targets: args.targets,
		localScope: args.localScope,
		sessionAllowed: args.sessionAllowed,
		evalClassified: args.evalClassified,
		toolInfo: args.toolInfo,
		onAutoVerdict: args.onAutoVerdict,
	});
	return {
		finalAction: outcome.action,
		autoNote: outcome.note,
		autoTrace: outcome.trace,
		autoSkipped: outcome.skipped,
	};
}

const PATH_INPUT_KEYS = ["path", "file_path"] as const;

/** True when the tool call names its target path explicitly. */
function hasPathInput(event: ToolCallEvent): boolean {
	const input = event.input as Record<string, unknown>;
	return PATH_INPUT_KEYS.some((key) => typeof input[key] === "string");
}

function getTargetPaths(event: ToolCallEvent, cwd: string): string[] {
	if (event.toolName === "bash") return [];
	const input = event.input as Record<string, unknown>;
	for (const key of PATH_INPUT_KEYS) {
		if (typeof input[key] === "string") {
			return [canonicalizePath(input[key] as string, cwd)];
		}
	}
	return [canonicalizePath(cwd, cwd)];
}

function buildContextSuffix(
	paths: string[],
	matchedPattern?: string,
	pathLabel = "blocked path",
): string {
	const parts: string[] = [];
	if (paths.length > 0) {
		const label = paths.length > 1 ? `${pathLabel}s` : pathLabel;
		parts.push(`${label}: ${paths.map((p) => `"${p}"`).join(", ")}`);
	}
	if (matchedPattern !== undefined) {
		parts.push(`pattern: "${matchedPattern}"`);
	}
	return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

/**
 * Which kind of rule decided a verdict. Drives the restricted-path vs
 * restricted-pattern vs restricted-tool wording so the message reflects the
 * actual restriction instead of whether any path happened to resolve.
 */
type VerdictBasis = "pattern" | "tool" | "path" | "eval";

/**
 * Classify the rule behind the final action. `evalDecided` is true when an
 * eval-classification verdict, not a location rule, produced the final action.
 */
function resolveVerdictBasis(
	matches: {
		action: Action;
		matchedPattern?: string;
		matchedRule: boolean;
		matchedTool?: string;
	}[],
	finalAction: Action,
	evalDecided = false,
): VerdictBasis {
	const finalMatches = matches.filter((match) => match.action === finalAction);
	if (finalMatches.length === 0) return evalDecided ? "eval" : "path";
	// A policy defaultAction or a universal tool glob blocks every tool here.
	if (
		finalMatches.some(
			(match) => !match.matchedRule || match.matchedTool === "*",
		)
	)
		return "path";
	// Otherwise a matched rule decides: a bash pattern or a specific tool.
	if (finalMatches.some((match) => match.matchedPattern !== undefined))
		return "pattern";
	return "tool";
}

/** Whether a verdict should name the paths involved. */
function verdictShowsPaths(basis: VerdictBasis): boolean {
	return basis === "path" || basis === "tool";
}

/** The path label used in a verdict message for a given basis. */
function verdictPathLabel(basis: VerdictBasis): string {
	return basis === "path" ? "blocked path" : "path";
}

/** Sentence appended to a deny reason describing where the restriction lies. */
function pathRestrictionNote(
	basis: VerdictBasis,
	toolName: string,
	deniedPaths: string[],
): string {
	if (basis === "pattern") {
		return " Avoid the blocked pattern in any retry.";
	}
	if (basis === "eval") {
		return " Avoid this operation in any retry; a different tool or a rewritten command does not change it.";
	}
	if (basis === "tool") {
		if (deniedPaths.length === 0) {
			return ` The restriction is on the tool "${toolName}", not on any path — another tool can still perform this operation.`;
		}
		const label = deniedPaths.length > 1 ? "paths" : "path";
		const pronoun = deniedPaths.length > 1 ? "them" : "it";
		const paths = deniedPaths.map((p) => `"${p}"`).join(", ");
		return ` The restriction is on the tool "${toolName}", not the ${label} ${paths} — another tool can still reach ${pronoun}. Retry with a different tool instead.`;
	}
	return deniedPaths.length > 0
		? ` The restriction is on the PATH${deniedPaths.length > 1 ? "S" : ""} ${deniedPaths.map((p) => `"${p}"`).join(", ")} — not on the tool. Do NOT retry with a different tool (read, ls, glob, cat, etc.); all access to these paths is blocked.`
		: " Do NOT retry with a different tool; this path is blocked regardless of which tool is used.";
}

/** Rule details for persisting an "Allow for Project/Globally" choice. */
interface ApprovalPersistence {
	rule: Rule;
	config: ControlsResolvedConfig;
	policyNames: string[];
}

function matchingApprovalRule(
	config: ControlsResolvedConfig,
	policyName: string,
	toolName: string,
	command: string | null,
) {
	const rules = config.approvalRules?.filter(
		(rule) => rule.policy === undefined || rule.policy === policyName,
	);
	if (!rules || rules.length === 0) return undefined;
	const result = matchRuleWithDetails(
		{ defaultAction: "deny", rules },
		toolName,
		command,
	);
	return result.action === "allow" ? result : undefined;
}

/**
 * Build a human-readable summary of a tool call for richer ask prompts.
 * Returns undefined when no useful summary can be extracted.
 */
function buildToolSummary(event: ToolCallEvent): string | undefined {
	const input = event.input as Record<string, unknown>;

	switch (event.toolName) {
		case "read": {
			const path = typeof input.file_path === "string" ? input.file_path : "";
			const offset =
				typeof input.offset === "number" ? input.offset : undefined;
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			const parts: string[] = [path || "unknown"];
			if (offset !== undefined) parts.push(`from line ${offset}`);
			if (limit !== undefined) parts.push(`${limit} lines`);
			return `read ${parts.join(", ")}`;
		}
		case "write": {
			const path = typeof input.file_path === "string" ? input.file_path : "";
			const content = typeof input.content === "string" ? input.content : "";
			const size = content.length > 0 ? ` (${content.length} chars)` : "";
			return `write ${path || "unknown"}${size}`;
		}
		case "edit": {
			const path = typeof input.filePath === "string" ? input.filePath : "";
			// input may have `edits` (array) or `oldString`/`newString` (single)
			const edits = Array.isArray(input.edits) ? input.edits : [];
			const oldStr = typeof input.oldString === "string" ? input.oldString : "";
			const count =
				edits.length > 0
					? `${edits.length} replacement${edits.length > 1 ? "s" : ""}`
					: oldStr.length > 0
						? "1 replacement"
						: "";
			return `edit ${path || "unknown"}${count ? ` (${count})` : ""}`;
		}
		case "grep": {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			return `grep "${pattern}"`;
		}
		case "find": {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			return `find "${pattern}"`;
		}
		case "ls": {
			const path = typeof input.path === "string" ? input.path : "cwd";
			return `ls ${path}`;
		}
		case "bash": {
			const cmd =
				typeof input.command === "string" ? input.command.slice(0, 120) : "";
			return cmd || undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Check cross-cutting path protection rules.
 *
 * Path protection patterns (e.g. `*.env`, `~/.ssh/*`) apply to ALL tools.
 * If a file path matches a deny rule, the call is blocked regardless of
 * location-based policies. Returns undefined (allow) or a deny block result.
 */
function checkProtectedPaths(
	pathsToCheck: string[],
	config: ControlsResolvedConfig,
): ToolCallEventResult | undefined {
	const patterns = config.pathProtection;
	if (!patterns || Object.keys(patterns).length === 0) return undefined;

	for (const path of pathsToCheck) {
		const basename = path.split("/").pop() ?? path;
		for (const [pattern, action] of Object.entries(patterns)) {
			const matches =
				minimatch(basename, pattern, { dot: true }) ||
				minimatch(path, pattern, { dot: true });
			if (matches && action === "deny") {
				return {
					block: true,
					reason: `[pi-controls] Access denied — path "${path}" matches protected pattern "${pattern}".`,
				};
			}
		}
	}
	return undefined;
}

function checkPathProtection(
	toolName: string,
	event: ToolCallEvent,
	cwd: string,
	config: ControlsResolvedConfig,
): ToolCallEventResult | undefined {
	const input = event.input as Record<string, unknown>;
	const pathsToCheck: string[] = [];

	if (toolName === "bash") {
		const cmd = typeof input.command === "string" ? input.command : "";
		for (const token of cmd.split(/\s+/)) {
			if (
				token.startsWith("/") ||
				token.startsWith("~") ||
				token.startsWith(".")
			) {
				pathsToCheck.push(canonicalizePath(token, cwd));
			}
		}
	} else {
		pathsToCheck.push(...getTargetPaths(event, cwd));
	}

	return checkProtectedPaths(pathsToCheck, config);
}

/**
 * Prefix a nudge message with what triggered it so the model can tell
 * a native tool apart from a bash shell invocation.
 *
 * bash: `You ran bash `grep foo` (matched pattern `grep *`). <message>`
 * tool: `You called the `read` tool. <message>`
 */
export function formatNudgeMessage(
	toolName: string,
	command: string | null,
	matchedPattern: string | undefined,
	message: string,
): string {
	if (toolName === "bash" && command) {
		const cmd = command.length > 120 ? `${command.slice(0, 120)}…` : command;
		const pattern =
			matchedPattern !== undefined
				? ` (matched pattern \`${matchedPattern}\`)`
				: "";
		return `You ran bash \`${cmd}\`${pattern}. ${message}`;
	}
	return `You called the \`${toolName}\` tool. ${message}`;
}

function notifyDecision(
	ctx: ExtensionContext,
	action: Action,
	toolName: string,
	command: string | null,
	policyName: string | null,
	mode: ControlsMode = "enforce",
	deniedPaths: string[] = [],
	matchedPattern?: string,
	nudgeMessage?: string,
	decisionNote?: string,
	verdictBasis?: VerdictBasis,
): void {
	// In inform mode show everything (including allow) so user sees the full picture.
	// In enforce mode, allow is silent — only show non-allow decisions.
	if (mode !== "inform" && action === "allow") return;
	const policy = policyName ? ` [${policyName}]` : "";
	const cmd = command ? `: ${command.slice(0, 80)}` : "";
	// In inform mode: prefix non-allow actions with "would-" and always use info
	// so it's clear nothing was actually blocked.
	const label =
		mode === "inform" && action !== "allow" ? `would-${action}` : action;
	const type =
		mode === "inform"
			? "info"
			: action === "deny"
				? "error"
				: action === "ask"
					? "warning"
					: "info";
	if (action === "nudge" && nudgeMessage) {
		// Single line: caller context + nudge message inline (not blocked).
		const enriched = formatNudgeMessage(
			toolName,
			command,
			matchedPattern,
			nudgeMessage,
		);
		ctx.ui.notify(`pi-controls: nudge${policy} — ${enriched}`, "warning");
	} else {
		// Pattern and eval denies have no path restriction to name; a tool deny
		// names a reachable path, and only a genuine path restriction is "blocked".
		const showsPaths =
			verdictBasis === undefined || verdictShowsPaths(verdictBasis);
		const pathLabel =
			verdictBasis !== undefined && action === "deny"
				? verdictPathLabel(verdictBasis)
				: action === "deny"
					? "blocked path"
					: "path";
		const context = buildContextSuffix(
			showsPaths ? deniedPaths : [],
			matchedPattern,
			pathLabel,
		);
		const decisionSuffix = decisionNote ? ` — ${decisionNote}` : "";
		ctx.ui.notify(
			`pi-controls: ${label}${policy}${cmd}${context}${decisionSuffix}`,
			type,
		);
	}
}

async function executeAction(
	action: Action,
	toolName: string,
	command: string | null,
	ctx: ExtensionContext,
	deniedPaths: string[] = [],
	matchedPattern?: string,
	toolCallId?: string,
	nudgeMessage?: string,
	escalatedFromNudge?: string,
	summary?: string,
	approvalPersistence?: ApprovalPersistence,
	decisionNote?: string,
	verdictBasis?: VerdictBasis,
): Promise<ToolCallEventResult | undefined> {
	switch (action) {
		case "allow":
			return undefined;

		case "log":
			return undefined;

		case "nudge": {
			// Allow the tool call but register an enriched message (with caller
			// context) to be injected into the result.
			if (toolCallId && nudgeMessage) {
				pendingNudges.set(
					toolCallId,
					formatNudgeMessage(toolName, command, matchedPattern, nudgeMessage),
				);
			}
			return undefined;
		}

		case "ask": {
			// Check session-allow exact key first.
			let key = sessionAllowKey(toolName, command, deniedPaths, matchedPattern);
			if (sessionAllows.has(key)) return undefined;

			// For bash, also check arity-based pattern matches.
			if (
				toolName === "bash" &&
				command &&
				sessionAllowsBashMatches(command, deniedPaths)
			) {
				return undefined;
			}

			const summaryText = summary ? ` (${summary})` : "";
			const context = buildContextSuffix(deniedPaths, matchedPattern);
			const detail = context.length > 0 ? context : "";
			const decisionSuffix = decisionNote ? ` [${decisionNote}]` : "";
			const title = `[pi-controls] Allow ${toolName}${summaryText}?${detail}${decisionSuffix}`;
			const choices = ["Allow", "Allow for session"];
			if (approvalPersistence) {
				choices.push("Allow for Project", "Allow Globally");
			}
			choices.push("Deny");
			const prompt = await promptSelect(ctx, title, choices);
			const choice = prompt.choice;
			if (!choice || choice === "Deny") {
				if (prompt.unavailableReason) {
					return {
						block: true,
						reason: `[pi-controls] Approval is required for ${toolName}${command ? ` (${command.slice(0, 80)})` : ""}, but no interactive UI could answer the prompt: ${prompt.unavailableReason}. The call was blocked. Do not retry; ask the user to run it interactively.`,
					};
				}
				return {
					block: true,
					reason: `[pi-controls] Blocked by user: ${toolName}${command ? ` (${command.slice(0, 80)})` : ""}`,
				};
			}
			if (choice === "Allow for session") {
				// For bash without a specific matched pattern, use the arity-based key.
				if (toolName === "bash" && command && !matchedPattern) {
					key = sessionAllowKey(toolName, command, deniedPaths);
				}
				sessionAllows.add(key);
			}
			if (
				approvalPersistence &&
				(choice === "Allow for Project" || choice === "Allow Globally")
			) {
				try {
					const scope = choice === "Allow for Project" ? "project" : "global";
					let policyName = approvalPersistence.policyNames[0];
					if (approvalPersistence.policyNames.length > 1) {
						const { choice: selected } = await promptSelect(
							ctx,
							"[pi-controls] Choose policy for the saved allow rule",
							approvalPersistence.policyNames,
						);
						if (!selected) {
							return {
								block: true,
								reason: `[pi-controls] Blocked by user: no policy selected for saved ${scope} allow rule`,
							};
						}
						policyName = selected;
					}
					const rule = { ...approvalPersistence.rule, policy: policyName };
					const saved = await addApprovalRule(scope, ctx.cwd, rule);
					if (saved.added) {
						approvalPersistence.config.approvalRules = [
							...(approvalPersistence.config.approvalRules ?? []),
							rule,
						];
					}
					ctx.ui.notify(
						`[pi-controls] ${saved.added ? "Saved" : "Existing"} allow rule for ${policyName} in ${scope} config: ${saved.path}`,
						"info",
					);
				} catch (error) {
					return {
						block: true,
						reason: `[pi-controls] Could not save allow rule: ${error}`,
					};
				}
			}
			return undefined;
		}

		case "deny": {
			const basis: VerdictBasis = verdictBasis ?? "path";
			const cmdPart = command ? ` (${command.slice(0, 80)})` : "";
			const context = buildContextSuffix(
				verdictShowsPaths(basis) ? deniedPaths : [],
				matchedPattern,
				verdictPathLabel(basis),
			);
			const decisionSuffix = decisionNote ? ` [${decisionNote}]` : "";
			const pathNote = pathRestrictionNote(basis, toolName, deniedPaths);
			const nudgeNote = escalatedFromNudge
				? ` You were repeatedly warned: "${escalatedFromNudge}". You MUST switch approach now.`
				: "";
			return {
				block: true,
				reason: `[pi-controls] Access denied by policy: ${toolName}${cmdPart}${context}${decisionSuffix}.${pathNote}${nudgeNote}`,
			};
		}
	}
}

/**
 * Apply the nudgeTimeout circuit breaker.
 *
 * If the resolved action is "nudge" and nudgeTimeout is configured:
 *  - Record the nudge in the per-rule tracker.
 *  - If the threshold has been reached for this rule, escalate to "deny" so
 *    the agent is forced to change approach. Reset the counter after escalation
 *    so the cycle can begin again if the agent keeps trying.
 *
 * Returns the (possibly escalated) action, and the nudge key used for tracking.
 */
function applyNudgeTimeout(
	action: Action,
	ruleKey: string,
	config: ControlsResolvedConfig,
	ctx: ExtensionContext,
): Action {
	if (action !== "nudge") return action;
	const timeout = config.nudgeTimeout;
	if (!timeout) return action;

	const tracker = getNudgeTracker(ruleKey);
	tracker.record();
	if (tracker.isTriggered(timeout.maxNudges, timeout.windowSeconds)) {
		tracker.reset();
		ctx.ui.notify(
			`[pi-controls] nudgeTimeout: repeated nudge ignored ${timeout.maxNudges} times — escalating to deny`,
			"error",
		);
		return "deny";
	}
	return action;
}

/**
 * Apply the agentTimeout circuit breaker.
 *
 * If the resolved action is "deny" and agentTimeout is configured:
 *  - Record the deny in the tracker.
 *  - If the threshold has been reached, escalate to "ask" so the user can
 *    step in and redirect the agent rather than letting it spin.
 *
 * Returns the (possibly escalated) action.
 */
function applyAgentTimeout(
	action: Action,
	config: ControlsResolvedConfig,
	ctx: ExtensionContext,
): Action {
	if (action !== "deny") return action;
	const timeout = config.agentTimeout;
	if (!timeout) return action;

	denyTracker.record();
	if (denyTracker.isTriggered(timeout.maxDenies, timeout.windowSeconds)) {
		ctx.ui.notify(
			`[pi-controls] agentTimeout: ${timeout.maxDenies} denies in ${timeout.windowSeconds}s — escalating to interactive confirm`,
			"warning",
		);
		return "ask";
	}
	return action;
}

export async function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: ControlsResolvedConfig,
	mode: ControlsMode = "enforce",
	toolInfo?: (name: string) => ToolInfo | undefined,
	onAutoVerdict?: AutoVerdictSink,
): Promise<ToolCallEventResult | undefined> {
	const cwd = ctx.cwd;

	// ── Cross-cutting path protection ──────────────────────────────────────
	const pathBlock = await checkPathProtection(
		event.toolName,
		event,
		cwd,
		config,
	);
	if (pathBlock) return pathBlock;

	// ── Bash ─────────────────────────────────────────────────────────────────
	if (event.toolName === "bash") {
		const input = event.input as { command: string };
		const stages = await parseCommand(input.command);
		const cmd = stages.map((s) => s.command).join(" | ");

		const matchResults: {
			action: Action;
			matchedPattern?: string;
			nudgeMessage?: string;
			ruleKey?: string;
			matchedRule: boolean;
			matchedTool?: string;
			stageIndex: number;
		}[] = [];
		const targets: string[] = [];
		// Paths the command actually names (no cwd placeholder for pathless
		// stages), used to resolve the auto `scope` deterministically.
		const namedTargets: string[] = [];
		const policyNames = new Set<string>();
		let policyName: string | null = null;
		let approvalAllowed = false;

		for (const [stageIndex, stage] of stages.entries()) {
			const stageTargets = [
				...new Set(
					[...stage.redirectFiles, ...stage.pathArgs].map((path) =>
						canonicalizePath(path, cwd),
					),
				),
			];
			namedTargets.push(...stageTargets);
			if (stageTargets.length === 0) stageTargets.push(cwd);

			for (const target of stageTargets) {
				targets.push(target);
				const resolved = resolvePolicy(target, cwd, config);
				if (resolved) {
					policyName = resolved.name;
					policyNames.add(resolved.name);
					const approved = matchingApprovalRule(
						config,
						resolved.name,
						"bash",
						stage.command,
					);
					if (approved) approvalAllowed = true;
					const result =
						approved ??
						matchRuleWithDetails(resolved.policy, "bash", stage.command);
					// Piped stages (e.g. `bun test | grep foo`) filter piped stdin
					// rather than searching files, so a nudge toward a
					// file-search tool does not apply. Only nudge when the
					// command is invoked directly.
					if (stage.pipedInput && !approved && result.action === "nudge") {
						continue;
					}
					// File dumps feeding a pipeline (e.g. `cat package.json | python3 -c ...`)
					// supply stdin to the next stage, which the read tool cannot do,
					// so a nudge toward the read tool does not apply.
					if (
						stage.pipedOutput &&
						!approved &&
						result.action === "nudge" &&
						stageFeedsPipe(stage)
					) {
						continue;
					}
					matchResults.push({
						action: result.action,
						matchedPattern: result.matchedPattern,
						nudgeMessage: result.nudgeMessage,
						ruleKey: nudgeKey("bash", result.matchedPattern),
						matchedRule: result.matchedRule,
						matchedTool: result.matchedTool,
						stageIndex,
					});
				}
			}
		}

		const uniqueTargets = [...new Set(targets)];
		const analyzedPathBlock = checkProtectedPaths(uniqueTargets, config);
		if (analyzedPathBlock) return analyzedPathBlock;

		const bashSessionAllowed = sessionAllowsBashMatches(cmd, uniqueTargets);

		// Eval classification (Decisions API): upgrade-only backstop for
		// inline evals. Skipped entirely when unconfigured or approved.
		const evalResult = await classifyEvalSources(
			ctx,
			stages,
			cmd,
			cwd,
			uniqueTargets,
			config,
			approvalAllowed,
			bashSessionAllowed,
		);
		const evalActions = evalResult.outcomes.map((outcome) => outcome.action);
		const evalTraces = evalResult.outcomes.map((outcome) => outcome.trace);

		if (
			matchResults.length === 0 &&
			evalActions.length === 0 &&
			!evalResult.skipped
		) {
			await logDecision({
				ts: new Date().toISOString(),
				tool: "bash",
				command: cmd,
				cwd,
				targets: uniqueTargets,
				policyName: null,
				action: "pass",
			});
			return undefined;
		}

		const actions = [
			...matchResults.map((result) => result.action),
			...evalActions,
		];
		const combinedAction = mostRestrictive(actions);

		// An eval classification only excuses the stages it actually judged. If
		// the `auto` verdict came from any non-eval stage, still run auto for the
		// call — otherwise `python -c '…'; rm -rf …` is silently allowed.
		const autoStages = new Set(
			matchResults
				.filter((result) => result.action === "auto")
				.map((result) => result.stageIndex),
		);
		const evalClassified =
			autoStages.size > 0 &&
			[...autoStages].every((index) => evalResult.classifiedStages.has(index));

		const { finalAction, autoNote, autoTrace, autoSkipped } =
			await resolveCombinedAction({
				combinedAction,
				ctx,
				config,
				toolName: "bash",
				input: event.input as Record<string, unknown>,
				targets: uniqueTargets,
				// Any expansion or substitution means the named paths are not the
				// whole story, so leave `scope` to the model.
				localScope: stages.every((stage) => stage.targetsResolved)
					? localScopeFromTargets(namedTargets, canonicalizePath(cwd, cwd))
					: undefined,
				sessionAllowed: bashSessionAllowed,
				evalClassified,
				toolInfo: toolInfo?.("bash"),
				onAutoVerdict,
			});

		// Cite the rule/pattern that produced the combined action; when `auto` won,
		// that is the `auto` rule even though the resolved verdict is concrete.
		const matchedPattern = matchResults
			.filter(
				(result) =>
					result.action === combinedAction &&
					result.matchedPattern !== undefined,
			)
			.map((result) => result.matchedPattern!)
			.sort((a, b) => b.length - a.length)[0];
		const nudgeMatch = matchResults.find(
			(result) =>
				result.action === combinedAction && result.nudgeMessage !== undefined,
		);
		const nudgeMessage = nudgeMatch?.nudgeMessage;
		const bashNudgeKey =
			nudgeMatch?.ruleKey ?? nudgeKey("bash", matchedPattern);
		const deniedTargets = finalAction === "deny" ? uniqueTargets : [];
		// Track whether an eval verdict, rather than a location rule, decided.
		const locationDecided = matchResults.some(
			(result) => result.action === finalAction,
		);
		const verdictBasis: VerdictBasis = resolveVerdictBasis(
			matchResults,
			finalAction,
			evalActions.length > 0 && !locationDecided,
		);

		// Cite the eval rationale when an eval verdict is binding or tied
		// with the location verdict (never for silent allows).
		const evalBinding =
			evalActions.length > 0 && mostRestrictive(evalActions) === combinedAction;
		const evalDetail =
			evalBinding && finalAction !== "allow"
				? evalResult.outcomes
						.filter((outcome) => outcome.action === finalAction)
						.map((outcome) => outcome.note)
						.join("; ")
				: "";
		const evalNote = evalDetail ? `eval: ${evalDetail}` : undefined;
		const decisionNote =
			[evalNote, autoNote].filter(Boolean).join("; ") || undefined;

		await logDecision({
			ts: new Date().toISOString(),
			tool: "bash",
			command: cmd,
			cwd,
			targets: uniqueTargets,
			policyName,
			action: finalAction,
			evals: evalTraces.length > 0 ? evalTraces : undefined,
			evalSkipped: evalResult.skipped,
			auto: autoTrace,
			autoSkipped,
		});
		notifyDecision(
			ctx,
			finalAction,
			"bash",
			cmd,
			policyName,
			mode,
			deniedTargets,
			matchedPattern,
			nudgeMessage,
			decisionNote,
			verdictBasis,
		);
		if (mode === "inform") return undefined;
		const effectiveBashAction = applyNudgeTimeout(
			applyAgentTimeout(finalAction, config, ctx),
			bashNudgeKey,
			config,
			ctx,
		);
		const bashEscalatedFromNudge =
			finalAction === "nudge" && effectiveBashAction === "deny"
				? nudgeMessage
				: undefined;
		const summary = cmd.slice(0, 120) || "bash";
		const approvalPersistence =
			stages.length === 1 && policyNames.size > 0
				? {
						rule: {
							action: "allow" as const,
							tool: "bash",
							pattern: suggestSessionPattern(stages[0].command),
						},
						config,
						policyNames: [...policyNames].sort(),
					}
				: undefined;
		return executeAction(
			effectiveBashAction,
			"bash",
			cmd,
			ctx,
			effectiveBashAction === "deny" || effectiveBashAction === "ask"
				? uniqueTargets
				: deniedTargets,
			matchedPattern,
			event.toolCallId,
			nudgeMessage,
			bashEscalatedFromNudge,
			summary,
			approvalPersistence,
			decisionNote,
			verdictBasis,
		);
	}

	// ── Non-bash ──────────────────────────────────────────────────────────────
	const targets = getTargetPaths(event, cwd);
	const matchResults: {
		action: Action;
		nudgeMessage?: string;
		ruleKey: string;
		matchedRule: boolean;
		matchedTool?: string;
	}[] = [];
	const policyNames = new Set<string>();
	let policyName: string | null = null;

	for (const target of targets) {
		const resolved = resolvePolicy(target, cwd, config);
		if (resolved) {
			policyName = resolved.name;
			policyNames.add(resolved.name);
			const result =
				matchingApprovalRule(config, resolved.name, event.toolName, null) ??
				matchRuleWithDetails(resolved.policy, event.toolName, null);
			matchResults.push({
				action: result.action,
				nudgeMessage: result.nudgeMessage,
				ruleKey: nudgeKey(event.toolName),
				matchedRule: result.matchedRule,
				matchedTool: result.matchedTool,
			});
		}
	}

	if (matchResults.length === 0) {
		await logDecision({
			ts: new Date().toISOString(),
			tool: event.toolName,
			cwd,
			targets,
			policyName: null,
			action: "pass",
		});
		return undefined;
	}

	const actions = matchResults.map((r) => r.action);
	const combinedAction = mostRestrictive(actions);

	const { finalAction, autoNote, autoTrace, autoSkipped } =
		await resolveCombinedAction({
			combinedAction,
			ctx,
			config,
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			targets,
			localScope: hasPathInput(event)
				? localScopeFromTargets(targets, canonicalizePath(cwd, cwd))
				: undefined,
			sessionAllowed: sessionAllows.has(
				sessionAllowKey(event.toolName, null, targets),
			),
			evalClassified: false,
			toolInfo: toolInfo?.(event.toolName),
			onAutoVerdict,
		});

	const nudgeMatch = matchResults.find(
		(r) => r.action === combinedAction && r.nudgeMessage !== undefined,
	);
	const nudgeMessage = nudgeMatch?.nudgeMessage;
	const toolNudgeKey = nudgeMatch?.ruleKey ?? nudgeKey(event.toolName);
	const verdictBasis: VerdictBasis = resolveVerdictBasis(
		matchResults,
		finalAction,
	);

	await logDecision({
		ts: new Date().toISOString(),
		tool: event.toolName,
		cwd,
		targets,
		policyName,
		action: finalAction,
		auto: autoTrace,
		autoSkipped,
	});
	notifyDecision(
		ctx,
		finalAction,
		event.toolName,
		null,
		policyName,
		mode,
		targets,
		undefined,
		nudgeMessage,
		autoNote,
		verdictBasis,
	);
	if (mode === "inform") return undefined;
	const effectiveAction = applyNudgeTimeout(
		applyAgentTimeout(finalAction, config, ctx),
		toolNudgeKey,
		config,
		ctx,
	);
	const escalatedFromNudge =
		finalAction === "nudge" && effectiveAction === "deny"
			? nudgeMessage
			: undefined;
	const summary = buildToolSummary(event);
	const approvalPersistence =
		policyNames.size > 0
			? {
					rule: { action: "allow" as const, tool: event.toolName },
					config,
					policyNames: [...policyNames].sort(),
				}
			: undefined;
	return executeAction(
		effectiveAction,
		event.toolName,
		null,
		ctx,
		effectiveAction === "deny" || effectiveAction === "ask" ? targets : [],
		undefined,
		event.toolCallId,
		nudgeMessage,
		escalatedFromNudge,
		summary,
		approvalPersistence,
		autoNote,
		verdictBasis,
	);
}
