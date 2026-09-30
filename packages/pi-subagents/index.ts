import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defaultOperatorConfig, loadOperatorConfig } from "./src/config.js";
import {
	SPAWNER_TOOL_NAMES,
	SUBAGENT_CHILD_DISPOSED,
	SUBAGENT_CHILD_SESSION_CREATED,
} from "./src/constants.js";
import { gateForSession } from "./src/gate.js";
import { canSpawn, getLineageRegistry, resolveLineage } from "./src/lineage.js";
import { getRunRegistry } from "./src/run.js";
import { isToolAllowed } from "./src/selectors.js";
import {
	buildSubagentTools,
	type SessionState,
	type SubagentToolDeps,
} from "./src/tools.js";
import type { Lineage } from "./src/types.js";

/**
 * Personal Pi subagents.
 *
 * Registers `Agent`, `get_subagent_result`, and `steer_subagent` as model-only
 * orchestration tools, owns the depth ceiling and frozen tool policy, and spawns
 * exactly one child session per `Agent` call.
 */
export default function piSubagents(pi: ExtensionAPI): void {
	let sessionState: SessionState | undefined;
	let sessionId: string | undefined;

	const deps: SubagentToolDeps = {
		sendMessage: (payload, options) =>
			pi.sendMessage(payload, options ?? { triggerTurn: false }),
		loadConfig: () => {
			try {
				return loadOperatorConfig(getAgentDir());
			} catch {
				return defaultOperatorConfig();
			}
		},
		getSessionState: () => sessionState,
		emitChildCreated: (parentSessionId, childSessionId) => {
			pi.events.emit(SUBAGENT_CHILD_SESSION_CREATED, {
				sessionId: childSessionId,
				parentSessionId,
			});
		},
		emitChildDisposed: (childSessionId) => {
			pi.events.emit(SUBAGENT_CHILD_DISPOSED, { sessionId: childSessionId });
		},
		emitEvent: (channel, data) => pi.events.emit(channel, data),
	};

	for (const tool of buildSubagentTools(deps)) {
		pi.registerTool(tool as ToolDefinition);
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		sessionId = ctx.sessionManager.getSessionId();
		const agentDir = getAgentDir();

		let config = defaultOperatorConfig();
		try {
			config = loadOperatorConfig(agentDir);
		} catch (error) {
			ctx.ui.notify(
				`[pi-subagents] ${(error as Error).message}; using defaults`,
				"warning",
			);
		}

		let lineage = resolveLineage(sessionId) as Lineage | undefined;
		if (!lineage) {
			lineage = { sessionId, depth: 0, ceiling: config.maxDepth };
			getLineageRegistry().register(lineage);
		}
		sessionState = { cwd: ctx.cwd, agentDir, config, lineage };

		// Frozen selectors restrict what the model sees. The dispatch gate enforces
		// the same policy for code paths that bypass active declarations.
		if (lineage.policy) {
			pi.setActiveTools(
				pi
					.getActiveTools()
					.filter((name) => isToolAllowed(lineage?.policy, name)),
			);
		}

		// At the ceiling the spawner is not exposed at all.
		if (!canSpawn(lineage)) {
			pi.setActiveTools(
				pi
					.getActiveTools()
					.filter((name) => !SPAWNER_TOOL_NAMES.includes(name)),
			);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const decision = gateForSession(
			ctx.sessionManager.getSessionId(),
			event.toolName,
		);
		if (decision) return { block: true, reason: decision.reason };
		return undefined;
	});

	pi.on("session_shutdown", () => {
		const registry = getRunRegistry();
		for (const run of registry.list()) {
			if (run.parentSessionId !== sessionId) continue;
			if (!run.terminal) run.requestTermination("aborted");
			run.disposeChild();
			registry.delete(run.id);
		}
		if (sessionId) getLineageRegistry().delete(sessionId);
		sessionState = undefined;
	});
}

export { spawnSubagent, type SpawnRequest } from "./src/runtime.js";
export {
	discoverAgentDefinitions,
	parseAgentDefinition,
} from "./src/definition.js";
export { loadOperatorConfig, parseOperatorConfig } from "./src/config.js";
export { resolveChildModel } from "./src/model.js";
export { resolveToolPolicy, isToolAllowed } from "./src/selectors.js";
export { decideToolCall } from "./src/gate.js";
