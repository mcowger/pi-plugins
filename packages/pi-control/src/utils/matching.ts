import { minimatch } from "minimatch";
import type { Action, Policy, Rule } from "../config.js";

// ─── Glob helpers ───────────────────────────────────────────────────────────────

/** Match a tool name against a tool glob pattern (e.g. "github_*"). */
function matchTool(pattern: string, toolName: string): boolean {
	return minimatch(toolName, pattern, { nocase: false, dot: true });
}

/**
 * Match a bash command string against a command pattern (e.g. "git commit *").
 *
 * Uses a simple regex conversion rather than minimatch: command strings are not
 * filesystem paths, so minimatch's path-segment semantics break on commands
 * like `find /deep/path -name *.md` where slashes and spaces are just chars.
 *
 * `*` matches any sequence of characters (including spaces, slashes, dots).
 * `?` matches any single character.
 */
export function matchCommand(pattern: string, command: string): boolean {
	const reSource = pattern
		.split(/([*?])/)
		.map((part, i, arr) => {
			const token = arr[i];
			if (token === "*") return ".*";
			if (token === "?") return ".";
			return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${reSource}$`, "s").test(command);
}

// ─── Specificity scoring ──────────────────────────────────────────────────────

/**
 * Count literal characters before the first wildcard (`*` or `?`).
 * Used to rank rules: higher score = more specific.
 */
export function specificityScore(pattern: string): number {
	const idx = pattern.search(/[*?]/);
	return idx === -1 ? pattern.length : idx;
}

/** Tiebreaker: lower number = higher priority in a tie. */
const ACTION_PRIORITY: Record<Action, number> = {
	allow: 0,
	nudge: 1,
	ask: 2,
	deny: 3,
	log: 4,
};

/** Result of matching a rule — action plus optional pattern that matched. */
export interface MatchResult {
	action: Action;
	/** For bash with a pattern match, the specific pattern that matched. */
	matchedPattern?: string;
	/** For nudge rules, the reminder message to inject into the tool result. */
	nudgeMessage?: string;
}

// ─── Rule matching ────────────────────────────────────────────────────────────

/**
 * Find the winning action for a tool call within a single policy.
 * Returns the policy's defaultAction if no rule matches.
 */
export function matchRule(
	policy: Policy,
	toolName: string,
	command: string | null, // null for non-bash tools
): Action {
	return matchRuleWithDetails(policy, toolName, command).action;
}

/**
 * Like matchRule but also returns which pattern matched (for bash).
 */
export function matchRuleWithDetails(
	policy: Policy,
	toolName: string,
	command: string | null, // null for non-bash tools
): MatchResult {
	let bestScore = -1;
	let bestPriority = Number.MAX_SAFE_INTEGER;
	let bestAction: Action | null = null;
	let bestPattern: string | undefined;
	let bestNudgeMessage: string | undefined;
	for (const rule of policy.rules) {
		// Tool glob must match.
		if (!matchTool(rule.tool, toolName)) continue;

		// For bash, the command pattern must also match (if specified).
		let patternMatched = false;
		if (toolName === "bash" && rule.pattern !== undefined) {
			patternMatched = command !== null && matchCommand(rule.pattern, command);
			if (!patternMatched) continue;
		}

		const scorePattern =
			toolName === "bash" && rule.pattern !== undefined
				? rule.pattern
				: rule.tool;
		const score = specificityScore(scorePattern);
		const priority = ACTION_PRIORITY[rule.action];

		if (score > bestScore || (score === bestScore && priority < bestPriority)) {
			bestScore = score;
			bestPriority = priority;
			bestAction = rule.action;
			bestPattern = patternMatched ? rule.pattern : undefined;
			bestNudgeMessage = rule.action === "nudge" ? rule.message : undefined;
		}
	}

	return {
		action: bestAction ?? policy.defaultAction,
		matchedPattern: bestPattern,
		nudgeMessage: bestNudgeMessage,
	};
}

// ─── Multi-target resolution ──────────────────────────────────────────────────

/** Restrictiveness order: deny > ask > log > nudge > allow */
const RESTRICTIVENESS: Action[] = ["deny", "ask", "log", "nudge", "allow"];

/**
 * Given actions from multiple policies (one per target), return the most
 * restrictive one.
 */
export function mostRestrictive(actions: Action[]): Action {
	for (const a of RESTRICTIVENESS) {
		if (actions.includes(a)) return a;
	}
	return "allow";
}
