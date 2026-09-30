import { AGENT_TOOL_NAME, SPAWNER_TOOL_NAMES } from "./constants.js";
import { canSpawn, resolveLineage } from "./lineage.js";
import { isToolAllowed } from "./selectors.js";
import type { Lineage } from "./types.js";

/**
 * Reduce a session's active (declared) tool set to what its lineage permits.
 *
 * The `Agent` tool is always retained: it carries the `prepareLoadout` hook that
 * hides tools activated after session start (codemode/tool_search and MCP direct
 * tools activate via `_refreshToolRegistry` → `_applyToolLoadout`). Filtering it
 * out would leave those late tools declared to the model. `prepareLoadout` hides
 * `Agent` itself when the policy excludes it or the depth ceiling is reached.
 *
 * The dispatch gate remains the execution-time backstop for calls that bypass
 * declarations (for example through `ctx.executeTool`).
 */
export function filterActiveTools(
	active: readonly string[],
	lineage: Lineage | undefined,
): string[] {
	if (!lineage) return [...active];
	let names = [...active];
	if (lineage.policy) {
		names = names.filter(
			(name) => name === AGENT_TOOL_NAME || isToolAllowed(lineage.policy, name),
		);
	}
	if (!canSpawn(lineage)) {
		names = names.filter(
			(name) => name === AGENT_TOOL_NAME || !SPAWNER_TOOL_NAMES.includes(name),
		);
	}
	return names;
}

export interface GateDecision {
	block: true;
	reason: string;
}

/**
 * Decide whether a single tool call is permitted for a session.
 *
 * This runs on every `tool_call`, including calls a codemode script makes
 * through `ctx.executeTool()`, so permitting `codemode` never permits an
 * excluded or non-included underlying tool (section 10).
 */
export function decideToolCall(
	lineage: Lineage | undefined,
	toolName: string,
): GateDecision | undefined {
	if (!lineage) return undefined;
	if (SPAWNER_TOOL_NAMES.includes(toolName) && !canSpawn(lineage)) {
		return {
			block: true,
			reason: `subagent spawner is not available at depth ${lineage.depth} (ceiling ${lineage.ceiling})`,
		};
	}
	if (!isToolAllowed(lineage.policy, toolName)) {
		return {
			block: true,
			reason: `tool "${toolName}" is not permitted for this subagent run`,
		};
	}
	return undefined;
}

/** Resolve the lineage for the calling session and decide the call. */
export function gateForSession(
	sessionId: string | undefined,
	toolName: string,
): GateDecision | undefined {
	return decideToolCall(resolveLineage(sessionId), toolName);
}
