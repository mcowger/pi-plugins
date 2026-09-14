import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ControlsMode } from "../index.js";
import {
	addApprovalRule,
	DEFAULT_INTERPRETER_ANALYSIS,
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
import { normalizePath } from "../utils/path.js";
import { parseCommand } from "../utils/bash-ast.js";
import { logDecision } from "../utils/logger.js";
import { minimatch } from "minimatch";
import { DenyTracker } from "../utils/deny-tracker.js";
import { suggestSessionPattern } from "../utils/bash-arity.js";
import { analyzeCommandStageSource } from "../utils/command-source-analysis.js";

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

function getTargetPaths(event: ToolCallEvent, cwd: string): string[] {
	if (event.toolName === "bash") return [];
	const input = event.input as Record<string, unknown>;
	for (const key of ["path", "file_path"]) {
		if (typeof input[key] === "string") {
			return [normalizePath(input[key] as string, cwd)];
		}
	}
	return [cwd];
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
 * Build an ask prompt for an interpreter-analysis fallback.
 *
 * The paths are policy-evaluation targets, not necessarily prohibited paths.
 * Keeping them separate from the analysis reason avoids implying that a
 * location policy blocked an otherwise allowed command.
 */
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

function buildAnalysisAskTitle(
	toolName: string,
	command: string | null,
	targets: string[],
	decisionReason: string,
): string {
	const commandSection = command
		? `\n\nCommand:\n${command.slice(0, 240)}`
		: "";
	const reasonList = decisionReason
		.split("; ")
		.map((reason) => `• ${reason}`)
		.join("\n");
	const targetSection =
		targets.length > 0
			? `\n\nPolicy-evaluated target${targets.length === 1 ? "" : "s"}:\n${targets.map((target) => `• ${target}`).join("\n")}`
			: "";
	return (
		`[pi-controls] Allow ${toolName}?` +
		commandSection +
		"\n\nReason for confirmation:\n" +
		"Static analysis could not prove the interpreter source safe:\n" +
		reasonList +
		targetSection
	);
}

/**
 * Compact one-line reason string for use in notify/log lines and the "Trust"
 * prompt option. Long reason lists are truncated so the agent does not have
 * to scroll through a wall of text.
 */
function summarizeReasons(decisionReason: string, limit = 240): string {
	const trimmed = decisionReason.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}…`;
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
				pathsToCheck.push(normalizePath(token, cwd));
			}
		}
	} else {
		pathsToCheck.push(...getTargetPaths(event, cwd));
	}

	return checkProtectedPaths(pathsToCheck, config);
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
		// Single line: no path label (not blocked), nudge message inline.
		ctx.ui.notify(`pi-controls: nudge${policy} — ${nudgeMessage}`, "warning");
	} else {
		// Use "path" for log/ask (not yet blocked); "blocked path" only for deny.
		const pathLabel = action === "deny" ? "blocked path" : "path";
		const context = buildContextSuffix(deniedPaths, matchedPattern, pathLabel);
		ctx.ui.notify(`pi-controls: ${label}${policy}${cmd}${context}`, type);
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
	decisionReason?: string,
	approvalPersistence?: ApprovalPersistence,
): Promise<ToolCallEventResult | undefined> {
	switch (action) {
		case "allow":
			return undefined;

		case "log":
			return undefined;

		case "nudge": {
			// Allow the tool call but register a message to be injected into the result.
			if (toolCallId && nudgeMessage) {
				pendingNudges.set(toolCallId, nudgeMessage);
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

			// Interpreter-analysis fallbacks need a structured explanation. In
			// particular, their targets are evaluated paths, not blocked paths.
			const summaryText = summary ? ` (${summary})` : "";
			const context = buildContextSuffix(deniedPaths, matchedPattern);
			const detail = context.length > 0 ? context : "";
			const title = decisionReason
				? buildAnalysisAskTitle(toolName, command, deniedPaths, decisionReason)
				: `[pi-controls] Allow ${toolName}${summaryText}?${detail}`;
			const choices = ["Allow", "Allow for session"];
			if (approvalPersistence) {
				choices.push("Allow for Project", "Allow Globally");
			}
			if (decisionReason && approvalPersistence) {
				choices.push("Trust this pattern");
			}
			choices.push("Deny");
			const choice = await ctx.ui.select(title, choices);
			if (!choice || choice === "Deny") {
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
						const selected = await ctx.ui.select(
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
			if (choice === "Trust this pattern" && approvalPersistence) {
				try {
					let policyName = approvalPersistence.policyNames[0];
					if (approvalPersistence.policyNames.length > 1) {
						const selected = await ctx.ui.select(
							"[pi-controls] Choose policy for the trusted allow rule",
							approvalPersistence.policyNames,
						);
						if (!selected) {
							return {
								block: true,
								reason:
									"[pi-controls] Blocked by user: no policy selected for trusted allow rule",
							};
						}
						policyName = selected;
					}
					const rule = {
						...approvalPersistence.rule,
						policy: policyName,
						allowUnanalyzed: true,
					};
					const saved = await addApprovalRule("global", ctx.cwd, rule);
					if (saved.added) {
						approvalPersistence.config.approvalRules = [
							...(approvalPersistence.config.approvalRules ?? []),
							rule,
						];
					}
					ctx.ui.notify(
						`[pi-controls] ${saved.added ? "Trusted" : "Already trusted"} allow rule for ${policyName}: ${saved.path}`,
						"info",
					);
				} catch (error) {
					return {
						block: true,
						reason: `[pi-controls] Could not save trusted allow rule: ${error}`,
					};
				}
			}
			return undefined;
		}

		case "deny": {
			const cmdPart = command ? ` (${command.slice(0, 80)})` : "";
			const context = buildContextSuffix(deniedPaths, matchedPattern);
			const analysisNote = decisionReason
				? ` Static analysis could not prove the source safe: ${decisionReason}.`
				: "";
			const pathNote =
				deniedPaths.length > 0
					? ` The restriction is on the PATH${deniedPaths.length > 1 ? "S" : ""} ${deniedPaths.map((p) => `"${p}"`).join(", ")} — not on the tool. Do NOT retry with a different tool (read, ls, glob, cat, etc.); all access to these paths is blocked.`
					: " Do NOT retry with a different tool; this path is blocked regardless of which tool is used.";
			const nudgeNote = escalatedFromNudge
				? ` You were repeatedly warned: "${escalatedFromNudge}". You MUST switch approach now.`
				: "";
			return {
				block: true,
				reason: `[pi-controls] Access denied by policy: ${toolName}${cmdPart}${context}.${analysisNote}${pathNote}${nudgeNote}`,
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
		const interpreterConfig =
			config.interpreterAnalysis === null
				? { ...DEFAULT_INTERPRETER_ANALYSIS, enabled: false }
				: (config.interpreterAnalysis ?? DEFAULT_INTERPRETER_ANALYSIS);

		const matchResults: {
			action: Action;
			matchedPattern?: string;
			nudgeMessage?: string;
			ruleKey?: string;
			allowUnanalyzed?: boolean;
		}[] = [];
		const targets: string[] = [];
		const discoveredPaths: string[] = [];
		const analysisReasons: string[] = [];
		const policyNames = new Set<string>();
		let policyName: string | null = null;

		for (const stage of stages) {
			let analyzedPaths: string[] = [];
			const stageAnalysisReasons: string[] = [];
			if (interpreterConfig.enabled) {
				try {
					const analysis = await analyzeCommandStageSource(stage, {
						cwd,
						maxDepth: interpreterConfig.maxDepth,
						maxNodes: interpreterConfig.maxNodes,
						maxSourceBytes: interpreterConfig.maxSourceBytes,
					});
					analyzedPaths = analysis.findings
						.flatMap((finding) => (finding.path === null ? [] : [finding.path]))
						.map((path) => normalizePath(path, cwd));
					stageAnalysisReasons.push(
						...analysis.unresolvedEffects,
						...analysis.parseErrors,
					);
				} catch (error) {
					stageAnalysisReasons.push(`Interpreter analysis failed: ${error}`);
				}
			}

			const explicitPaths = [...stage.redirectFiles, ...stage.pathArgs].map(
				(path) => normalizePath(path, cwd),
			);
			const stageTargets = [...new Set([...explicitPaths, ...analyzedPaths])];
			discoveredPaths.push(...stageTargets);
			if (stageTargets.length === 0) stageTargets.push(cwd);

			const stageMatchResults: (typeof matchResults)[number][] = [];
			for (const target of stageTargets) {
				targets.push(target);
				const resolved = resolvePolicy(target, cwd, config);
				if (resolved) {
					policyName = resolved.name;
					policyNames.add(resolved.name);
					const result =
						matchingApprovalRule(
							config,
							resolved.name,
							"bash",
							stage.command,
						) ?? matchRuleWithDetails(resolved.policy, "bash", stage.command);
					const matchResult = {
						action: result.action,
						matchedPattern: result.matchedPattern,
						nudgeMessage: result.nudgeMessage,
						ruleKey: nudgeKey("bash", result.matchedPattern),
						allowUnanalyzed: result.allowUnanalyzed,
					};
					matchResults.push(matchResult);
					stageMatchResults.push(matchResult);
				}
			}

			const sourceIsExplicitlyTrusted =
				stageAnalysisReasons.length > 0 &&
				stageMatchResults.length > 0 &&
				stageMatchResults.every((result) => result.allowUnanalyzed);
			if (!sourceIsExplicitlyTrusted) {
				analysisReasons.push(...stageAnalysisReasons);
			}
		}

		const uniqueTargets = [...new Set(targets)];
		const analyzedPathBlock = checkProtectedPaths(
			[...new Set(discoveredPaths)],
			config,
		);
		if (analyzedPathBlock) return analyzedPathBlock;

		const uniqueAnalysisReasons = [...new Set(analysisReasons)];
		const interpreterWasInvoked = stages.some(
			(stage) => stage.embeddedSources.length > 0,
		);
		const earlyTrustedAllow =
			uniqueAnalysisReasons.length > 0 &&
			interpreterWasInvoked &&
			matchResults.length > 0 &&
			matchResults.every(
				(result) =>
					result.action === "allow" && result.allowUnanalyzed === true,
			);
		if (uniqueAnalysisReasons.length > 0 && !earlyTrustedAllow) {
			matchResults.push({ action: interpreterConfig.unknownAction });
		}

		if (matchResults.length === 0) {
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

		const actions = matchResults.map((result) => result.action);
		const finalAction = mostRestrictive(actions);
		const matchedPattern = matchResults
			.filter(
				(result) =>
					result.action === finalAction && result.matchedPattern !== undefined,
			)
			.map((result) => result.matchedPattern!)
			.sort((a, b) => b.length - a.length)[0];
		const nudgeMatch = matchResults.find(
			(result) =>
				result.action === finalAction && result.nudgeMessage !== undefined,
		);
		const nudgeMessage = nudgeMatch?.nudgeMessage;
		const bashNudgeKey =
			nudgeMatch?.ruleKey ?? nudgeKey("bash", matchedPattern);
		const deniedTargets = finalAction === "deny" ? uniqueTargets : [];
		const analysisReason = uniqueAnalysisReasons.join("; ");

		await logDecision({
			ts: new Date().toISOString(),
			tool: "bash",
			command: cmd,
			cwd,
			targets: uniqueTargets,
			policyName,
			action: finalAction,
			reason: analysisReason || undefined,
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
		const summary = analysisReason
			? `${cmd.slice(0, 80)}; unresolved source: ${summarizeReasons(analysisReason, 160)}`
			: cmd.slice(0, 120) || "bash";
		const approvalPersistence =
			stages.length === 1 && policyNames.size > 0
				? {
						rule: {
							action: "allow" as const,
							tool: "bash",
							pattern: suggestSessionPattern(stages[0].command),
							allowUnanalyzed: true,
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
			analysisReason || undefined,
			approvalPersistence,
		);
	}

	// ── Non-bash ──────────────────────────────────────────────────────────────
	const targets = getTargetPaths(event, cwd);
	const matchResults: {
		action: Action;
		nudgeMessage?: string;
		ruleKey: string;
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
	const finalAction = mostRestrictive(actions);
	const nudgeMatch = matchResults.find(
		(r) => r.action === finalAction && r.nudgeMessage !== undefined,
	);
	const nudgeMessage = nudgeMatch?.nudgeMessage;
	const toolNudgeKey = nudgeMatch?.ruleKey ?? nudgeKey(event.toolName);

	await logDecision({
		ts: new Date().toISOString(),
		tool: event.toolName,
		cwd,
		targets,
		policyName,
		action: finalAction,
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
		undefined,
		approvalPersistence,
	);
}
