import type { ControlsResolvedConfig, Policy, Rule } from "../config.js";
import { matchRule, matchTool } from "./matching.js";

/**
 * True when `policy` can never let `toolName` run.
 *
 * The policy is evaluated without a command, which is exact for non-bash tools.
 * Bash is different: its `pattern` rules only match a concrete command, so a
 * policy that denies by default but allows `git *` (or `$safe-bash`) must keep
 * bash available. Any non-deny bash pattern rule, in the policy or in a saved
 * approval for it, keeps bash visible.
 */
function policyDeniesTool(
	policy: Policy,
	policyName: string,
	toolName: string,
	approvalRules: Rule[],
): boolean {
	if (matchRule(policy, toolName, null) !== "deny") return false;
	const approvals = approvalRules.filter(
		(rule) => rule.policy === undefined || rule.policy === policyName,
	);
	if (toolName === "bash") {
		return ![...policy.rules, ...approvals].some(
			(rule) =>
				rule.pattern !== undefined &&
				rule.action !== "deny" &&
				matchTool(rule.tool, "bash"),
		);
	}
	return (
		matchRule({ defaultAction: "deny", rules: approvals }, toolName, null) !==
		"allow"
	);
}

/**
 * Tools that every active policy (referenced by `locations` or
 * `defaultPolicy`) denies outright. These are removed from the agent's
 * toolset, since no call to them could ever run.
 */
export function universallyDeniedTools(
	tools: readonly string[],
	config: ControlsResolvedConfig,
): string[] {
	const names = new Set(Object.values(config.locations));
	if (config.defaultPolicy) names.add(config.defaultPolicy);
	const active = [...names].filter((name) => name in config.policies);
	if (active.length === 0) return [];
	const approvals = config.approvalRules ?? [];
	return tools.filter((tool) =>
		active.every((name) =>
			policyDeniesTool(config.policies[name], name, tool, approvals),
		),
	);
}
