import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL } from "./src/bridge.js";
import { defaultOperatorConfig, loadOperatorConfig } from "./src/config.js";
import {
	SUBAGENT_CHILD_DISPOSED,
	SUBAGENT_CHILD_SESSION_CREATED,
	PLEXUSPI_ROOT_SIGNAL_CHANNEL,
} from "./src/constants.js";
import { filterActiveTools, gateForSession } from "./src/gate.js";
import { getLineageRegistry, resolveLineage } from "./src/lineage.js";
import { getRunRegistry } from "./src/run.js";
import {
	buildSubagentTools,
	type SessionState,
	type SubagentToolDeps,
} from "./src/tools.js";
import {
	formatMs,
	formatTokens,
	type NotificationDetails,
} from "./src/transcript.js";
import type { Lineage } from "./src/types.js";

/**
 * Personal Pi subagents.
 *
 * Registers `Agent`, `get_subagent_result`, and `steer_subagent` as model-only
 * orchestration tools, owns the depth ceiling and frozen tool policy, and spawns
 * exactly one child session per `Agent` call.
 */
export default function piSubagents(pi: ExtensionAPI): void {
	// The Plexuspi companion owns the `--plexuspi-companion-root` launch flag. This
	// extension must not register it again (a duplicate registration is a
	// diagnostic); instead it learns its root identity from the public root
	// signal the companion emits once its root session starts.
	let sessionState: SessionState | undefined;
	let sessionId: string | undefined;
	const rootSessionIds = new Set<string>();
	let rootSignalUnsubscribe: (() => void) | undefined;

	function recordRootSignal(data: unknown): void {
		if (!data || typeof data !== "object") return;
		const signal = data as { version?: unknown; sessionId?: unknown };
		if (signal.version !== 1) return;
		if (typeof signal.sessionId !== "string" || signal.sessionId.length === 0)
			return;
		rootSessionIds.add(signal.sessionId);
	}

	function subscribeRootSignal(): void {
		if (rootSignalUnsubscribe) return;
		const events = pi.events;
		if (!events || typeof events.on !== "function") return;
		rootSignalUnsubscribe = events.on(
			PLEXUSPI_ROOT_SIGNAL_CHANNEL,
			recordRootSignal,
		);
	}

	function unsubscribeRootSignal(): void {
		rootSignalUnsubscribe?.();
		rootSignalUnsubscribe = undefined;
	}

	// Subscribe at factory time so a signal emitted by the companion before this
	// extension's own session_start handler is still recorded.
	subscribeRootSignal();

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
		// Lazy root check: the companion's signal is recorded against a session id,
		// and `sessionId` is rebound on every session_start. A child session never
		// receives the signal, so only the signaled root session matches.
		isPlexuspiRoot: () =>
			sessionId !== undefined && rootSessionIds.has(sessionId),
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
		emitBridge: (record) =>
			pi.events.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, record),
	};

	for (const tool of buildSubagentTools(deps)) {
		pi.registerTool(tool as ToolDefinition);
	}

	// Render the completion notification as a concise block instead of its raw
	// `<task-notification>` content.
	pi.registerMessageRenderer<NotificationDetails>(
		"subagent-notification",
		(message, { expanded }, theme) => {
			const details = message.details;
			if (!details) return undefined;
			const failed =
				details.status === "error" ||
				details.status === "stopped" ||
				details.status === "aborted";
			const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const status = failed
				? details.status
				: details.status === "steered"
					? "completed (steered)"
					: "completed";
			let line = `${icon} ${theme.bold(details.description)} ${theme.fg("dim", status)}`;
			const parts: string[] = [];
			if (details.toolUses > 0)
				parts.push(
					`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`,
				);
			if (details.totalTokens > 0)
				parts.push(formatTokens(details.totalTokens));
			if (details.durationMs > 0) parts.push(formatMs(details.durationMs));
			if (parts.length > 0) {
				line += `\n  ${parts.map((part) => theme.fg("dim", part)).join(theme.fg("dim", " · "))}`;
			}
			const preview = expanded
				? details.resultPreview
				: (details.resultPreview.split("\n")[0]?.slice(0, 80) ?? "");
			if (preview) line += `\n  ${theme.fg("dim", `⎿  ${preview}`)}`;
			if (details.outputFile) {
				line += `\n  ${theme.fg("dim", `transcript: ${details.outputFile}`)}`;
			}
			return new Text(line, 0, 0);
		},
	);

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
		// Re-arm the subscription in case a prior session_shutdown released it.
		subscribeRootSignal();
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
		sessionState = {
			cwd: ctx.cwd,
			agentDir,
			config,
			lineage,
			trusted: ctx.isProjectTrusted(),
		};
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
		rootSessionIds.clear();
		unsubscribeRootSignal();
		sessionState = undefined;
	});
}

export { spawnSubagent, type SpawnRequest } from "./src/runtime.js";
export {
	PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL,
	PLEXUSPI_SUBAGENT_BRIDGE_VERSION,
	type PlexuspiSubagentActivityKind,
	type PlexuspiSubagentActivityRecord,
	type PlexuspiSubagentBridgeOutcome,
	type PlexuspiSubagentBridgeRecord,
	type PlexuspiSubagentBridgeType,
} from "./src/bridge.js";
export {
	discoverAgentDefinitions,
	parseAgentDefinition,
} from "./src/definition.js";
export { loadOperatorConfig, parseOperatorConfig } from "./src/config.js";
export { resolveChildModel } from "./src/model.js";
export { resolveToolPolicy, isToolAllowed } from "./src/selectors.js";
export { decideToolCall } from "./src/gate.js";
