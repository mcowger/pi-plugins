import { Type } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type ExtensionToolContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	AGENT_TOOL_NAME,
	GET_RESULT_TOOL_NAME,
	SPAWNER_TOOL_NAMES,
	STEER_TOOL_NAME,
} from "./constants.js";
import { discoverAgentDefinitions } from "./definition.js";
import { resolveInvocation } from "./invocation.js";
import { canSpawn, resolveLineage } from "./lineage.js";
import { AgentAdmissionError } from "./model.js";
import { getRunRegistry, type SubagentRun } from "./run.js";
import { isToolAllowed } from "./selectors.js";
import { spawnSubagent } from "./runtime.js";
import {
	buildBackgroundDetails,
	buildBackgroundResultText,
	buildCreatedEvent,
	buildEventData,
	buildGetResultText,
	buildNotFoundText,
	buildNotificationDetails,
	buildNotificationText,
	buildStartedEvent,
	buildSteeredEvent,
	buildSteerNotRunningText,
	buildSteerSentText,
	notificationDeliveryOptions,
	RUN_IN_BACKGROUND_NOTE,
} from "./transcript.js";
import type { AgentDefinition, Lineage, OperatorConfig } from "./types.js";

export interface SessionState {
	cwd: string;
	agentDir: string;
	config: OperatorConfig;
	lineage: Lineage;
	/** Whether the session is trusted to read project `.pi/agents/`. */
	trusted: boolean;
}

export interface SendMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface SubagentToolDeps {
	/** Bound `pi.sendMessage`. */
	sendMessage(
		payload: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		},
		options?: SendMessageOptions,
	): void;
	/** Re-read operator config for an admission. */
	loadConfig(): OperatorConfig;
	/** Session-scoped facts captured on session_start. */
	getSessionState(): SessionState | undefined;
	/** Announce an in-process child before its extensions bind. */
	emitChildCreated(parentSessionId: string, childSessionId: string): void;
	/** Announce a child's disposal after a terminal state. */
	emitChildDisposed(childSessionId: string): void;
	/** Emit a cross-extension lifecycle event on the parent's bus. */
	emitEvent(channel: string, data: unknown): void;
}

function currentState(
	deps: SubagentToolDeps,
	ctx: ExtensionToolContext,
): SessionState {
	const state = deps.getSessionState();
	if (state) return state;
	// Fall back to the live context when session_start has not populated state,
	// so programmatic/admission calls still enforce depth and config.
	const config = deps.loadConfig();
	return {
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		config,
		lineage: {
			sessionId: ctx.sessionManager.getSessionId(),
			depth: 0,
			ceiling: config.maxDepth,
		},
		trusted: ctx.isProjectTrusted(),
	};
}

function resolveDefinition(
	state: SessionState,
	typedName: string,
	ctx: ExtensionToolContext,
): AgentDefinition {
	const { definitions, diagnostics } = discoverAgentDefinitions({
		agentDir: state.agentDir,
		cwd: state.cwd,
		trusted: ctx.isProjectTrusted(),
	});
	const definition = definitions.get(typedName);
	if (!definition) {
		const known = [...definitions.keys()].sort().join(", ") || "(none)";
		const detail = diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ");
		throw new Error(
			`unknown subagent_type "${typedName}"; known agents: ${known}${detail ? `; definition errors: ${detail}` : ""}`,
		);
	}
	return definition;
}

/**
 * Model-facing catalog appended to the Agent tool description.
 *
 * Pi re-sends tool descriptions on every request and refreshes them through
 * `prepareLoadout` when the active tool set changes, so the model always sees
 * the available agents even after a long run or a compaction.
 */
export function buildAgentCatalog(
	definitions: Map<string, AgentDefinition>,
): string {
	const entries = [...definitions.values()]
		.filter((definition) => definition.enabled)
		.sort((a, b) => a.name.localeCompare(b.name));
	if (entries.length === 0) return "";
	const lines = entries.map(
		(definition) =>
			`- ${definition.name}: ${definition.description ?? definition.name}`,
	);
	return `\n\nAvailable agents (pass the name as subagent_type):\n${lines.join("\n")}`;
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function cleanList(
	value: readonly string[] | undefined,
	field: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	return value.map((entry) => requireNonEmpty(entry, `${field} entry`));
}

const SPAWN_PARAMETERS = Type.Object(
	{
		subagent_type: Type.String({
			description: "Agent definition name (file in the agents directory)",
		}),
		prompt: Type.String({ description: "Task for the child agent" }),
		description: Type.String({
			description: "Short human-facing description",
		}),
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Deprecated and ignored: every child runs in the background so its transcript can stream. Use get_subagent_result with wait: true to block for the result.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description: "Exact provider/modelId or a fuzzy model name",
			}),
		),
		thinking: Type.Optional(
			Type.String({
				description: "Thinking level from the model's supported levels",
			}),
		),
		included_tools: Type.Optional(
			Type.Array(Type.String(), {
				description: "Allowlist; [] means no tools",
			}),
		),
		excluded_tools: Type.Optional(
			Type.Array(Type.String(), {
				description: "Denylist; wins over inclusion",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), {
				description: "Approved extension refs to add",
			}),
		),
	},
	{ additionalProperties: false },
);

const GET_RESULT_PARAMETERS = Type.Object(
	{
		agent_id: Type.String({ description: "Id returned by Agent" }),
		wait: Type.Optional(
			Type.Boolean({
				description: "Await terminal state without advancing the child",
			}),
		),
	},
	{ additionalProperties: false },
);

const STEER_PARAMETERS = Type.Object(
	{
		agent_id: Type.String({ description: "Id returned by Agent" }),
		message: Type.String({
			description: "The steering message to send",
		}),
	},
	{ additionalProperties: false },
);

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details,
	} as AgentToolResult<unknown>;
}

const AGENT_TOOL_DESCRIPTION =
	"Spawn exactly one subagent child in the background and return its run id " +
	"and transcript path. The child runs while you continue; a completion " +
	"notification wakes you. Use get_subagent_result with wait: true to block " +
	"for the result (that replaces the notification), or independent calls for " +
	"parallelism.";

export function buildAgentTool(deps: SubagentToolDeps) {
	return {
		name: AGENT_TOOL_NAME,
		label: "Agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Spawn one background subagent child",
		// Orchestration tools are declared to the model but never callable through codemode.
		exposure: "model-only" as const,
		parameters: SPAWN_PARAMETERS,
		// Hide tools the frozen policy forbids, including those activated after
		// session_start (for example MCP direct tools). The dispatch gate still
		// enforces the same policy for calls that bypass declarations.
		prepareLoadout: (loadout: { declared: readonly { name: string }[] }) => {
			const state = deps.getSessionState();
			if (!state) return undefined;
			const hidden = new Set<string>();
			if (state.lineage.policy) {
				for (const tool of loadout.declared) {
					if (!isToolAllowed(state.lineage.policy, tool.name))
						hidden.add(tool.name);
				}
			}
			if (!canSpawn(state.lineage)) {
				for (const name of SPAWNER_TOOL_NAMES) hidden.add(name);
			}
			const { definitions } = discoverAgentDefinitions({
				agentDir: state.agentDir,
				cwd: state.cwd,
				trusted: state.trusted,
			});
			const catalog = buildAgentCatalog(definitions);
			if (hidden.size === 0 && !catalog) return undefined;
			return {
				...(hidden.size > 0 ? { hiddenDeclarations: [...hidden] } : {}),
				...(catalog
					? {
							descriptions: {
								[AGENT_TOOL_NAME]: AGENT_TOOL_DESCRIPTION + catalog,
							},
						}
					: {}),
			};
		},
		async execute(
			toolCallId: string,
			params: {
				subagent_type: string;
				prompt: string;
				description: string;
				/** Accepted for compatibility; every child runs in the background. */
				run_in_background?: boolean;
				model?: string;
				thinking?: string;
				included_tools?: string[];
				excluded_tools?: string[];
				extensions?: string[];
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionToolContext,
		): Promise<AgentToolResult<unknown>> {
			const state = currentState(deps, ctx);
			const lineage =
				resolveLineage(ctx.sessionManager.getSessionId()) ?? state.lineage;
			if (!canSpawn(lineage)) {
				throw new Error(
					`depth ceiling ${lineage.ceiling} reached; spawning is not available here`,
				);
			}
			const subagentType = requireNonEmpty(
				params.subagent_type,
				"subagent_type",
			);
			const prompt = requireNonEmpty(params.prompt, "prompt");
			const definition = resolveDefinition(state, subagentType, ctx);

			const invocation = resolveInvocation(definition, {
				model: params.model,
				thinking: params.thinking,
			});
			// Every child is a background session: only then does Paseo learn the
			// transcript path at spawn time and stream it live. Callers that want a
			// blocking inline result use get_subagent_result's `wait`.
			invocation.runInBackground = true;
			if (invocation.inheritContext) {
				throw new AgentAdmissionError(
					`agent "${definition.name}" sets inherit_context: true, which is not supported in v1`,
				);
			}

			const includedTools = cleanList(
				params.included_tools,
				"included_tools",
			) ?? [...definition.tools];

			const run = await spawnSubagent({
				cwd: state.cwd,
				agentDir: state.agentDir,
				parentSessionId: state.lineage.sessionId,
				parentDepth: lineage.depth,
				parentCeiling: lineage.ceiling,
				lookup: ctx.modelRegistry,
				parentModel: ctx.model,
				parentThinking: ctx.thinkingLevel,
				config: state.config,
				definition,
				invocation,
				prompt,
				description: params.description,
				toolCallId,
				includedTools,
				excludedTools: cleanList(params.excluded_tools, "excluded_tools"),
				extensions: cleanList(params.extensions, "extensions"),
				onTerminal: (finished) => {
					const failed =
						finished.status === "error" ||
						finished.status === "stopped" ||
						finished.status === "aborted";
					deps.emitEvent(
						failed ? "subagents:failed" : "subagents:completed",
						buildEventData(finished),
					);
					// Always send the notification: Paseo's tintinweb adapter derives the
					// child's terminal status from its `details`. Only the wake-up turn is
					// suppressed when a caller already claimed the result.
					deps.sendMessage(
						{
							customType: "subagent-notification",
							content: buildNotificationText(finished),
							display: true,
							details: buildNotificationDetails(finished, 500),
						},
						notificationDeliveryOptions(finished),
					);
				},
				onChildCreated: (childSessionId) =>
					deps.emitChildCreated(state.lineage.sessionId, childSessionId),
				onChildDisposed: (childSessionId) =>
					deps.emitChildDisposed(childSessionId),
			});

			deps.emitEvent("subagents:created", buildCreatedEvent(run));
			deps.emitEvent("subagents:started", buildStartedEvent(run));

			// If the caller still passed the deprecated flag, start the agent in the
			// background anyway and say so in the result.
			const note =
				params.run_in_background === undefined
					? undefined
					: RUN_IN_BACKGROUND_NOTE;
			return textResult(
				buildBackgroundResultText(run, { note }),
				buildBackgroundDetails(run),
			);
		},
	};
}

export function buildGetResultTool() {
	return {
		name: GET_RESULT_TOOL_NAME,
		label: "Get subagent result",
		description:
			"Check status and retrieve results from a subagent. Use the agent ID returned by Agent. Set wait: true to block until the child finishes and return its result.",
		exposure: "model-only" as const,
		parameters: GET_RESULT_PARAMETERS,
		async execute(
			_toolCallId: string,
			params: { agent_id: string; wait?: boolean },
		): Promise<AgentToolResult<unknown>> {
			const agentId = requireNonEmpty(params.agent_id, "agent_id");
			const run = getRunRegistry().get(agentId);
			if (!run) return textResult(buildNotFoundText(agentId));
			if (params.wait === true) {
				// Claim before blocking: the notification fires from the terminal hook,
				// which runs before this await resumes.
				run.claimResult();
				await run.settled;
			} else if (run.terminal) {
				run.claimResult();
			}
			// tintinweb's followup result carries text only; the Paseo adapter
			// correlates by agent id from the spawn call.
			return textResult(buildGetResultText(run));
		},
	};
}

export function buildSteerTool(deps: SubagentToolDeps) {
	return {
		name: STEER_TOOL_NAME,
		label: "Steer subagent",
		description:
			"Send a steering message to a running agent. The message will interrupt the agent after its current tool execution.",
		exposure: "model-only" as const,
		parameters: STEER_PARAMETERS,
		async execute(
			_toolCallId: string,
			params: { agent_id: string; message: string },
		): Promise<AgentToolResult<unknown>> {
			const agentId = requireNonEmpty(params.agent_id, "agent_id");
			const run = getRunRegistry().get(agentId);
			if (!run) return textResult(buildNotFoundText(agentId));
			if (run.terminal) return textResult(buildSteerNotRunningText(run));

			const session = run.childSession as {
				isStreaming?: boolean;
				steer(text: string): Promise<unknown>;
				prompt(text: string): Promise<void>;
				getContextUsage?(): { percent?: number | null } | undefined;
			};
			if (session.isStreaming) await session.steer(params.message);
			else await session.prompt(params.message);
			run.contextPercent ??= session.getContextUsage?.()?.percent ?? undefined;
			deps.emitEvent(
				"subagents:steered",
				buildSteeredEvent(run, params.message),
			);
			return textResult(buildSteerSentText(run));
		},
	};
}

export function buildSubagentTools(deps: SubagentToolDeps) {
	return [buildAgentTool(deps), buildGetResultTool(), buildSteerTool(deps)];
}
