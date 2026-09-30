import { AgentAdmissionError } from "./model.js";
import type { AgentDefinition, OperatorConfig } from "./types.js";

/**
 * Resolve approved extension refs for a child.
 *
 * - Per-agent `extensions` omitted inherits the approved parent optional set.
 * - Per-agent `extensions: []` selects none of the approved optional set.
 * - Per-call `extensions` appends, from approved refs only.
 * - Operator `excludedExtensions` always wins.
 *
 * Mandatory builtins (MCP, codemode, tool_search) are handled separately and are
 * never affected by this result.
 */
export function resolveApprovedExtensionRefs(
	config: OperatorConfig,
	definition: AgentDefinition,
	perCallExtensions: readonly string[] | undefined,
): string[] {
	const inherited =
		definition.extensions === undefined
			? Object.keys(config.approvedExtensions)
			: definition.extensions;
	const requested = [...inherited, ...(perCallExtensions ?? [])];
	const excluded = new Set(config.excludedExtensions);
	const refs: string[] = [];
	const seenRefs = new Set<string>();
	for (const name of requested) {
		if (excluded.has(name)) continue;
		const ref = config.approvedExtensions[name];
		if (ref === undefined) {
			throw new AgentAdmissionError(
				`extension "${name}" is not an operator-approved source; approved: ${Object.keys(config.approvedExtensions).join(", ") || "(none)"}`,
			);
		}
		if (seenRefs.has(ref)) continue;
		seenRefs.add(ref);
		refs.push(ref);
	}
	return refs;
}
