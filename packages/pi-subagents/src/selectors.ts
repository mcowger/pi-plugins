import type { ToolPolicy } from "./types.js";

/**
 * Build a frozen tool policy from spawn selectors.
 *
 * - `included` omitted (`undefined`) means every available tool.
 * - `included: []` means no tools at all, direct or through codemode.
 * - `excluded` always wins over inclusion.
 */
export function resolveToolPolicy(
	included: readonly string[] | undefined,
	excluded: readonly string[] | undefined,
): ToolPolicy {
	return {
		included: included === undefined ? undefined : Object.freeze([...included]),
		excluded: Object.freeze([...(excluded ?? [])]),
	};
}

/** Whether a tool name passes a policy. `undefined` policy means all allowed. */
export function isToolAllowed(
	policy: ToolPolicy | undefined,
	toolName: string,
): boolean {
	if (!policy) return true;
	if (policy.excluded.includes(toolName)) return false;
	if (policy.included === undefined) return true;
	return policy.included.includes(toolName);
}

/** Names explicitly referenced by a policy, for diagnostics. */
export function policyToolNames(policy: ToolPolicy | undefined): string[] {
	if (!policy) return [];
	return [...new Set([...(policy.included ?? []), ...policy.excluded])];
}
