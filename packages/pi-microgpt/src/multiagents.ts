import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCollaborationTools } from "pi-multiagents-v2/extensions/collaboration-tools.ts";
import { ROOT, TeamManager } from "pi-multiagents-v2/extensions/team-manager.ts";
import type { PiModel } from "./model-support.ts";

type SupportedModelCheck = (model: PiModel | undefined) => model is PiModel;
type ModelLookup = (provider: string, id: string) => PiModel | undefined;

const COLLABORATION_INSTRUCTIONS = `You are /root, the primary agent in a team of Pi agents.
Use spawn_agent for concrete, bounded work that can run independently while you continue useful local work. Child agents can recursively spawn their own children. All agents share the same working directory and filesystem, so give coding agents disjoint write scopes.
Use send_message to pass information without starting an idle agent, followup_task to give an existing non-root agent more work, wait_agent only when blocked on incoming work, list_agents to inspect the tree, and interrupt_agent to stop an agent's current turn. Child final answers are delivered automatically as FINAL_ANSWER messages.
Agent messages arrive in this form:
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload: <payload>`;

export function validateSpawnModelOverride(
	modelName: string | undefined,
	inheritedModel: PiModel | undefined,
	findModel: ModelLookup,
	isSupportedModel: SupportedModelCheck,
): void {
	if (!isSupportedModel(inheritedModel)) {
		throw new Error("Multi-agent tools require a supported GPT Responses API model");
	}
	if (!modelName) return;

	const slash = modelName.indexOf("/");
	const provider = slash >= 0 ? modelName.slice(0, slash) : inheritedModel.provider;
	const id = slash >= 0 ? modelName.slice(slash + 1) : modelName;
	const selected = findModel(provider, id);
	if (!isSupportedModel(selected)) {
		throw new Error(`Child model must be a supported GPT Responses API model: ${modelName}`);
	}
}

function guardedTools(tools: ToolDefinition[], isSupportedModel: SupportedModelCheck): ToolDefinition[] {
	return tools.map((tool) => {
		const execute = tool.execute.bind(tool);
		return {
			...tool,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSupportedModel(ctx.model as PiModel | undefined)) {
					throw new Error("Multi-agent tools require a supported GPT Responses API model");
				}
				return execute(id, params, signal, onUpdate, ctx);
			},
		};
	});
}

export function installMultiAgentTools(pi: ExtensionAPI, isSupportedModel: SupportedModelCheck): void {
	const team = new TeamManager(pi);
	const spawn = team.spawn.bind(team);
	team.spawn = async (source, params, ctx) => {
		validateSpawnModelOverride(params.model, ctx.model as PiModel | undefined, (provider, id) =>
			ctx.modelRegistry.find(provider, id) as Model<Api> | undefined,
			isSupportedModel,
		);
		return spawn(source, params, ctx);
	};

	const internals = team as unknown as { createTools(source: string): ToolDefinition[] };
	const createChildTools = internals.createTools.bind(team);
	internals.createTools = (source) => guardedTools(createChildTools(source), isSupportedModel);

	const rootTools = guardedTools(createCollaborationTools(team, ROOT), isSupportedModel);
	for (const tool of rootTools) pi.registerTool(tool);
	const toolNames = rootTools.map((tool) => tool.name);

	function syncTools(model: Model<Api> | undefined): void {
		const active = new Set(pi.getActiveTools());
		if (isSupportedModel(model)) {
			for (const name of toolNames) active.add(name);
		} else {
			for (const name of toolNames) active.delete(name);
		}
		pi.setActiveTools([...active]);
	}

	pi.on("session_start", (_event, ctx) => {
		team.start(ctx);
		syncTools(ctx.model);
	});
	pi.on("model_select", (event) => syncTools(event.model));
	pi.on("before_agent_start", (event, ctx) => {
		if (!isSupportedModel(ctx.model)) return;
		return {
			systemPrompt: event.systemPrompt.includes("You are /root, the primary agent in a team of Pi agents.")
				? event.systemPrompt
				: `${event.systemPrompt}\n\n${COLLABORATION_INSTRUCTIONS}`,
		};
	});
	pi.on("agent_start", () => team.setRootStatus("running"));
	pi.on("agent_settled", () => team.setRootStatus({ completed: null }));
	pi.on("input", (event) => {
		if (event.streamingBehavior === "steer") team.signalRootSteer();
	});
	pi.on("session_shutdown", async () => team.dispose());
}
