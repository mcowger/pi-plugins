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

/**
 * Canonical form of a tool name for policy matching. Pi 0.99.2 rewrites `-` to
 * `_` in MCP namespace and tool names (`mcp__my-server__x` -> `mcp__my_server__x`),
 * so policies written with either spelling must match tools from either host.
 */
function canonicalToolName(name: string): string {
	return name.startsWith("mcp__") ? name.replaceAll("-", "_") : name;
}

function listHas(names: readonly string[], canonical: string): boolean {
	return names.some((name) => canonicalToolName(name) === canonical);
}

/** Whether a tool name passes a policy. `undefined` policy means all allowed. */
export function isToolAllowed(
	policy: ToolPolicy | undefined,
	toolName: string,
): boolean {
	if (!policy) return true;
	const canonical = canonicalToolName(toolName);
	if (listHas(policy.excluded, canonical)) return false;
	if (policy.included === undefined) return true;
	return listHas(policy.included, canonical);
}

/** Names explicitly referenced by a policy, for diagnostics. */
export function policyToolNames(policy: ToolPolicy | undefined): string[] {
	if (!policy) return [];
	return [...new Set([...(policy.included ?? []), ...policy.excluded])];
}
