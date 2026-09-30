import { SPAWNER_TOOL_NAMES } from "./constants.js";
import { canSpawn, resolveLineage } from "./lineage.js";
import { isToolAllowed } from "./selectors.js";
import type { Lineage } from "./types.js";

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
