import { StringEnum, type TSchema, Type } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "./constants.ts";
import type { AgentDefinition, SuperAgentsConfig } from "./types.ts";

const AGENT_TOOL_INTRO =
	"Run tasks on specialised sub-agents. Each task runs in a fresh isolated session with the agent's own tools and model, and returns the agent's final answer. Tasks in one call run in parallel. Sub-agents cannot see this conversation, so each prompt must contain all needed context. Use background: true to keep working while they run; results arrive automatically as a message (or use agent_wait).";

const NO_AGENTS_TEXT =
	"No sub-agents are configured. Agent definitions live in ~/.pi/agent/agents/*.md or .pi/agents/*.md.";

export const AGENT_WAIT_DESCRIPTION =
	"Wait for background sub-agents to finish and return their results. Omit ids to wait for all undelivered background runs.";

export const AGENT_STOP_DESCRIPTION = "Abort running or queued sub-agents by id or name.";

export const AGENT_STATUS_DESCRIPTION =
	"List sub-agent runs with status. Do not poll; results are delivered automatically.";

export function buildAgentToolParams(agents: AgentDefinition[], cfg: SuperAgentsConfig): TSchema {
	const allowsOverride = agents.some((agent) => agent.allowModelOverride);

	return Type.Object(
		{
			tasks: Type.Array(
				Type.Object(
					{
						agent: agents.length > 0 ? StringEnum(agents.map((agent) => agent.slug)) : Type.String(),
						prompt: Type.String({
							description: "Complete, self-contained instructions. The sub-agent cannot see this conversation.",
						}),
						name: Type.Optional(Type.String({ description: "Optional label for this run" })),
						...(allowsOverride
							? {
									model: Type.Optional(
										Type.String({
											description: "provider/model — applied only for agents marked [overridable]; ignored otherwise",
										}),
									),
									thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
								}
							: {}),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: cfg.maxTasksPerCall },
			),
			background: Type.Optional(Type.Boolean({ description: "Return immediately; results arrive later as a message" })),
		},
		{ additionalProperties: false },
	);
}

export function buildAgentToolDescription(agents: AgentDefinition[]): string {
	if (agents.length === 0) {
		return `${AGENT_TOOL_INTRO}\n\n${NO_AGENTS_TEXT}`;
	}

	const lines = agents.map(
		(agent) => `- ${agent.slug}: ${agent.description}${agent.allowModelOverride ? " [overridable]" : ""}`,
	);
	return `${AGENT_TOOL_INTRO}\n\nAgents:\n${lines.join("\n")}`;
}

export function buildAgentWaitParams(): TSchema {
	return Type.Object(
		{
			ids: Type.Optional(Type.Array(Type.String())),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
		},
		{ additionalProperties: false },
	);
}

export function buildAgentStopParams(): TSchema {
	return Type.Object(
		{
			ids: Type.Array(Type.String(), { minItems: 1 }),
		},
		{ additionalProperties: false },
	);
}

export function buildAgentStatusParams(): TSchema {
	return Type.Object({}, { additionalProperties: false });
}
