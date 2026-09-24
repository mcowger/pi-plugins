import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./agents.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { RESULT_MESSAGE_TYPE, TOOL_AGENT, TOOL_STATUS, TOOL_STOP, TOOL_WAIT } from "./constants.ts";
import { EventEmitter } from "./events.ts";
import { RunManager } from "./manager.ts";
import { formatRunResult } from "./results.ts";
import { runChild } from "./runner.ts";
import {
	AGENT_STATUS_DESCRIPTION,
	AGENT_STOP_DESCRIPTION,
	AGENT_WAIT_DESCRIPTION,
	buildAgentStatusParams,
	buildAgentStopParams,
	buildAgentToolDescription,
	buildAgentToolParams,
	buildAgentWaitParams,
} from "./tool-defs.ts";
import type { AgentDefinition, RunRecord, SuperAgentsConfig, TaskInput } from "./types.ts";

interface AgentTaskParam {
	agent: string;
	prompt: string;
	name?: string;
	model?: string;
	thinking?: TaskInput["thinking"];
}

interface AgentToolParams {
	tasks: AgentTaskParam[];
	background?: boolean;
}

interface RunSummary {
	id: string;
	name: string;
	slug: string;
	status: string;
	model?: string;
	thinking?: string;
	usage?: unknown;
	error?: string;
	outputPath?: string;
	durationMs?: number;
}

function summary(r: RunRecord): RunSummary {
	return {
		id: r.id,
		name: r.name,
		slug: r.slug,
		status: r.status,
		model: r.model,
		thinking: r.thinking,
		usage: r.usage,
		error: r.error,
		outputPath: r.outputPath,
		durationMs: r.startedAt !== undefined && r.endedAt !== undefined ? r.endedAt - r.startedAt : undefined,
	};
}

let runChildImpl: typeof runChild = runChild;

/** Test-only seam: swap the child-session runner without going through a real Pi SDK session. */
export function __setRunChildForTests(fn: typeof runChild): void {
	runChildImpl = fn;
}

const NOT_INITIALISED = "super-agents-pi is not initialised";

export default function superAgents(pi: ExtensionAPI): void {
	const ownPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	let agents = new Map<string, AgentDefinition>();
	let config: SuperAgentsConfig = DEFAULT_CONFIG;
	let manager: RunManager | undefined;
	let latestCtx: ExtensionContext | undefined;

	function pushResult(text: string, details: unknown): void {
		try {
			pi.sendMessage(
				{ customType: RESULT_MESSAGE_TYPE, content: text, display: true, details },
				{ triggerTurn: true, deliverAs: latestCtx?.isIdle() === false ? "steer" : "followUp" },
			);
		} catch (err) {
			console.error("super-agents-pi: failed to push background result", err);
		}
	}

	function registerTools(list: AgentDefinition[], cfg: SuperAgentsConfig): void {
		const slugs = list.map((agent) => agent.slug);

		pi.registerTool({
			name: TOOL_AGENT,
			label: "Run Sub-agents",
			description: buildAgentToolDescription(list),
			...(slugs.length > 0 ? { promptSnippet: `Delegate tasks to sub-agents: ${slugs.join(", ")}` } : {}),
			parameters: buildAgentToolParams(list, cfg),
			async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
				latestCtx = ctx;
				if (!manager) throw new Error(NOT_INITIALISED);
				const params = rawParams as AgentToolParams;
				const background = !!params.background;

				const { records, done } = manager.startTasks({
					tasks: params.tasks as TaskInput[],
					background,
					parentToolCallId: toolCallId,
					ctx,
					signal: background ? undefined : signal,
					onProgress: background
						? undefined
						: (recs) =>
								onUpdate?.({
									content: [{ type: "text", text: recs.map((r) => `${r.name}: ${r.status}`).join("\n") }],
									details: { runs: recs.map(summary) },
								}),
				});

				if (background) {
					return {
						content: [
							{
								type: "text",
								text: `Started in background:\n${records
									.map((r) => `- ${r.name} (${r.slug}) [id: ${r.id}]`)
									.join("\n")}\nResults will arrive automatically as a message.`,
							},
						],
						details: { runs: records.map(summary) },
					};
				}

				await done;
				for (const r of records) r.delivered = true;
				return {
					content: [{ type: "text", text: records.map((r) => formatRunResult(r, r.resultText ?? "")).join("\n\n") }],
					details: { runs: records.map(summary) },
				};
			},
		});

		pi.registerTool({
			name: TOOL_WAIT,
			label: "Wait for Sub-agents",
			description: AGENT_WAIT_DESCRIPTION,
			parameters: buildAgentWaitParams(),
			async execute(_toolCallId, rawParams, signal) {
				if (!manager) throw new Error(NOT_INITIALISED);
				const params = rawParams as { ids?: string[]; timeout_seconds?: number };
				const timeoutMs = (params.timeout_seconds ?? 600) * 1000;
				const { finished, pending } = await manager.wait(params.ids, timeoutMs, signal);
				const lines = [
					...finished.map((r) => formatRunResult(r, r.resultText ?? "")),
					...pending.map((r) => `- ${r.name} [${r.id}] still ${r.status}`),
				];
				return {
					content: [{ type: "text", text: lines.length > 0 ? lines.join("\n\n") : "No runs to wait for." }],
					details: { runs: [...finished, ...pending].map(summary) },
				};
			},
		});

		pi.registerTool({
			name: TOOL_STOP,
			label: "Stop Sub-agents",
			description: AGENT_STOP_DESCRIPTION,
			parameters: buildAgentStopParams(),
			async execute(_toolCallId, rawParams) {
				if (!manager) throw new Error(NOT_INITIALISED);
				const params = rawParams as { ids: string[] };
				const { stopped, notFound, alreadyFinished } = manager.stop(params.ids);
				const lines: string[] = [];
				if (stopped.length > 0) lines.push(`Stopped: ${stopped.join(", ")}`);
				if (alreadyFinished.length > 0) lines.push(`Already finished: ${alreadyFinished.join(", ")}`);
				if (notFound.length > 0) lines.push(`Not found: ${notFound.join(", ")}`);
				return {
					content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "Nothing to stop." }],
					details: { stopped, notFound, alreadyFinished },
				};
			},
		});

		pi.registerTool({
			name: TOOL_STATUS,
			label: "Sub-agent Status",
			description: AGENT_STATUS_DESCRIPTION,
			parameters: buildAgentStatusParams(),
			async execute() {
				if (!manager) throw new Error(NOT_INITIALISED);
				const records = manager.status();
				if (records.length === 0) {
					return { content: [{ type: "text", text: "No sub-agent runs." }], details: { runs: [] } };
				}
				const lines = records.map((r) => {
					const durationMs = r.startedAt !== undefined ? (r.endedAt ?? Date.now()) - r.startedAt : undefined;
					const seconds = durationMs !== undefined ? (durationMs / 1000).toFixed(1) : "-";
					return `${r.id}  ${r.name}  ${r.slug}  ${r.status}  ${seconds}s`;
				});
				return { content: [{ type: "text", text: lines.join("\n") }], details: { runs: records.map(summary) } };
			},
		});
	}

	// Registration-timing fallback: `pi.registerTool` calls made only inside the
	// `session_start` handler are not guaranteed to be visible to the model on
	// its very first turn (see packages/pi-microgpt/src/index.ts, which registers
	// its tools unconditionally at load time for the same reason). Register once
	// here with best-effort agent discovery, then re-register with the correct
	// per-session cwd/config in `session_start` below.
	{
		const agentDir = getAgentDir();
		const { agents: list } = loadAgents(process.cwd(), agentDir);
		for (const agent of list) agents.set(agent.slug, agent);
		registerTools(list, config);
	}

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		manager?.shutdown();

		const agentDir = getAgentDir();
		const { config: loadedConfig, warnings } = loadConfig(ctx.cwd, agentDir);
		const { agents: list, errors } = loadAgents(ctx.cwd, agentDir);

		config = loadedConfig;
		agents = new Map(list.map((agent) => [agent.slug, agent]));

		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.error(warning);
		}
		for (const error of errors) {
			const msg = `super-agents-pi: ${error.filePath}: ${error.message}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.error(msg);
		}

		const overflowRoot = config.overflowDir ?? path.join(tmpdir(), "super-agents-pi");
		const emitter = new EventEmitter({ append: (t, d) => pi.appendEntry(t, d), config });
		manager = new RunManager({
			config,
			getAgents: () => agents,
			runChild: (opts) => runChildImpl(opts),
			emitter,
			pushResult,
			cwd: ctx.cwd,
			agentDir,
			ownPackageDir,
			parentSessionId: ctx.sessionManager.getSessionId(),
			overflowRoot,
			warn: (msg) => {
				const full = `super-agents-pi: ${msg}`;
				if (ctx.hasUI) ctx.ui.notify(full, "warning");
				else console.error(full);
			},
		});

		registerTools(list, config);
	});

	pi.on("session_shutdown", () => {
		manager?.shutdown();
		manager = undefined;
	});
}
