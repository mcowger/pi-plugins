import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defaultOperatorConfig, loadOperatorConfig } from "./src/config.js";
import {
	SUBAGENT_CHILD_DISPOSED,
	SUBAGENT_CHILD_SESSION_CREATED,
} from "./src/constants.js";
import { filterActiveTools, gateForSession } from "./src/gate.js";
import { getLineageRegistry, resolveLineage } from "./src/lineage.js";
import { getRunRegistry } from "./src/run.js";
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

	// The active set is the tools declared to the model. Re-apply the frozen
	// policy whenever registrations can change it: at session start, before
	// every request (MCP direct tools and codemode/tool_search activate after
	// session_start), and when MCP servers connect.
	function applyActiveToolPolicy(): void {
		const state = sessionState;
		if (!state) return;
		pi.setActiveTools(filterActiveTools(pi.getActiveTools(), state.lineage));
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
		applyActiveToolPolicy();
	});

	pi.on("before_agent_start", () => {
		applyActiveToolPolicy();
	});

	pi.on("mcp_servers_change", () => {
		applyActiveToolPolicy();
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
