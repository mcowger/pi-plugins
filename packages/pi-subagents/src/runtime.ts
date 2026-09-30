import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveApprovedExtensionRefs } from "./extensions.js";
import type { ResolvedInvocation } from "./invocation.js";
import { childLineage, getLineageRegistry, runWithLineage } from "./lineage.js";
import {
	AgentAdmissionError,
	type ModelLookup,
	resolveChildModel,
	type ResolvedChildModel,
} from "./model.js";
import { getRunRegistry, SubagentRun } from "./run.js";
import { isWireSafePath } from "./transcript.js";
import type { AgentDefinition, OperatorConfig, ToolPolicy } from "./types.js";

/** Turns after the soft limit before the child is aborted. */
const GRACE_TURNS = 5;
const WRAP_UP_MESSAGE =
	"You have reached your turn limit. Wrap up immediately - provide your final answer now.";

export interface SpawnRequest {
	cwd: string;
	agentDir?: string;
	parentSessionId: string;
	parentDepth: number;
	parentCeiling: number;
	lookup: ModelLookup;
	parentModel?: Model<any>;
	parentThinking?: string;
	config: OperatorConfig;
	definition: AgentDefinition;
	invocation: ResolvedInvocation;
	prompt: string;
	description?: string;
	toolCallId?: string;
	includedTools?: readonly string[];
	excludedTools?: readonly string[];
	extensions?: string[];
	/** Absolute path of this extension's entry, always loaded into the child. */
	selfExtensionPath?: string;
	/** Called exactly once when the run reaches a terminal status. */
	onTerminal?: (run: SubagentRun) => void;
	/** In-process child lifecycle, following the pi-control convention. */
	onChildCreated?: (childSessionId: string) => void;
	onChildDisposed?: (childSessionId: string) => void;
}

function createRunId(): string {
	return randomBytes(6).toString("hex");
}

/** Short model label, matching tintinweb's tag rendering. */
function shortModelLabel(model: Model<any>): string {
	const name = model.id.includes("/") ? model.id.split("/").pop()! : model.id;
	return name.replace(/-\d{8}$/, "");
}

/** Invocation tags exactly as tintinweb builds them. */
function buildTags(
	definition: AgentDefinition,
	invocation: ResolvedInvocation,
): string[] {
	const tags: string[] = [];
	if (definition.promptMode === "append") tags.push("twin");
	if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
	if (invocation.inheritContext) tags.push("inherit context");
	if (invocation.runInBackground) tags.push("background");
	if (invocation.maxTurns != null)
		tags.push(`max turns: ${invocation.maxTurns}`);
	return tags;
}

/**
 * The child must load this extension so its own dispatch gate can enforce the
 * frozen selector policy and depth ceiling. Resolve our entry file; discovery
 * may also find it, and the loader dedupes by canonical path.
 */
function resolveSelfExtensionPath(override?: string): string {
	if (override && existsSync(override)) return override;
	try {
		if (import.meta.url.startsWith("file:")) {
			const resolved = fileURLToPath(new URL("../index.ts", import.meta.url));
			if (existsSync(resolved)) return resolved;
		}
	} catch {
		// Fall through to the fail-closed error below.
	}
	throw new AgentAdmissionError(
		"cannot resolve this extension's entry file; refusing to spawn without tool-policy enforcement",
	);
}

function createChildSessionManager(
	cwd: string,
	agentDir: string,
	runId: string,
): SessionManager {
	const preferred = join(agentDir, "subagents", runId);
	const sessionDir = isWireSafePath(preferred)
		? preferred
		: join(tmpdir(), "pi-subagents", runId);
	mkdirSync(sessionDir, { recursive: true });
	return SessionManager.create(cwd, sessionDir);
}

/**
 * Fail closed if the constructed session does not carry the frozen model and
 * thinking level. Runs after bind and before the first request.
 */
function assertEffectiveChild(
	session: AgentSession,
	resolved: ResolvedChildModel,
): void {
	const model = session.model;
	if (
		!model ||
		model.provider !== resolved.model.provider ||
		model.id !== resolved.model.id
	) {
		throw new AgentAdmissionError(
			`child session resolved to ${model?.provider ?? "?"}/${model?.id ?? "?"} instead of the frozen ${resolved.model.provider}/${resolved.model.id}`,
		);
	}
	if (
		resolved.thinking !== undefined &&
		session.thinkingLevel !== resolved.thinking
	) {
		throw new AgentAdmissionError(
			`child thinking level is ${session.thinkingLevel} instead of the frozen ${resolved.thinking}`,
		);
	}
}

/** Wrap the definition body per `prompt_mode`. */
function agentInstructions(definition: AgentDefinition): string | undefined {
	const body = definition.instructions.trim();
	if (!body) return undefined;
	return definition.promptMode === "append"
		? `<agent_instructions>\n${body}\n</agent_instructions>`
		: body;
}

interface TrackState {
	hardAborted: boolean;
	softSteered: boolean;
	/** Message from the last assistant response when it ended in a provider error. */
	providerError?: string;
}

interface AssistantUsage {
	input?: number;
	output?: number;
	cacheWrite?: number;
}

/**
 * Subscribe to the child's events to accumulate the metrics tintinweb reports
 * (tool uses, turns, lifetime tokens) and to enforce the soft/hard turn limit.
 */
function trackRun(
	session: AgentSession,
	run: SubagentRun,
	maxTurns: number | undefined,
): {
	state: TrackState;
	unsubscribe: () => void;
} {
	const state: TrackState = { hardAborted: false, softSteered: false };
	let turns = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_end") {
			run.toolUses++;
			return;
		}
		if (event.type === "turn_end") {
			turns++;
			run.turnCount = turns;
			if (!maxTurns || maxTurns <= 0) return;
			if (!state.softSteered && turns >= maxTurns) {
				state.softSteered = true;
				void Promise.resolve(session.steer(WRAP_UP_MESSAGE)).catch(() => {});
			} else if (state.softSteered && turns >= maxTurns + GRACE_TURNS) {
				state.hardAborted = true;
				void Promise.resolve(session.abort()).catch(() => {});
			}
			return;
		}
		if (event.type === "message_end") {
			const message = event.message as
				| {
						role?: string;
						usage?: AssistantUsage;
						stopReason?: string;
						errorMessage?: string;
				  }
				| undefined;
			if (message?.role === "assistant" && message.usage) {
				run.lifetimeUsage.input += message.usage.input ?? 0;
				run.lifetimeUsage.output += message.usage.output ?? 0;
				run.lifetimeUsage.cacheWrite += message.usage.cacheWrite ?? 0;
			}
			// Track the last assistant response: a recovered retry clears the flag.
			if (message?.role === "assistant") {
				state.providerError =
					message.stopReason === "error"
						? (message.errorMessage ?? "provider error")
						: undefined;
			}
		}
	});
	return { state, unsubscribe };
}

function captureContextPercent(run: SubagentRun, session: AgentSession): void {
	try {
		const percent = session.getContextUsage()?.percent;
		if (percent != null) run.contextPercent = percent;
	} catch {
		// Context usage is best-effort.
	}
}

/**
 * Terminal status for a child that finished its prompt without throwing.
 * A provider error wins over a turn-limit wrap-up; playback and live tests
 * pin the resulting `error` → `subagents:failed` behavior.
 */
export function resolveTerminalStatus(
	state: { providerError?: string; hardAborted: boolean; softSteered: boolean },
	maxTurns: number | undefined,
): { status: "error" | "aborted" | "steered" | "completed"; error?: string } {
	if (state.providerError)
		return { status: "error", error: state.providerError };
	if (state.hardAborted)
		return { status: "aborted", error: `max_turns ${maxTurns} reached` };
	if (state.softSteered) return { status: "steered" };
	return { status: "completed" };
}

async function runChild(
	run: SubagentRun,
	session: AgentSession,
	promptText: string,
	maxTurns: number | undefined,
	onTerminal: ((run: SubagentRun) => void) | undefined,
): Promise<void> {
	const tracker = trackRun(session, run, maxTurns);
	try {
		await session.prompt(promptText);
		captureContextPercent(run, session);
		run.resultText ??= session.getLastAssistantText();
		if (!run.terminal) {
			const terminal = resolveTerminalStatus(tracker.state, maxTurns);
			if (terminal.status === "completed") {
				run.transition("completed", {
					summary: session.getLastAssistantText(),
				});
			} else {
				run.transition(terminal.status, {
					error: terminal.error,
					summary: session.getLastAssistantText(),
				});
			}
		}
	} catch (error) {
		captureContextPercent(run, session);
		run.resultText ??= session.getLastAssistantText();
		if (!run.terminal) {
			const message = error instanceof Error ? error.message : String(error);
			const intent = run.terminationIntent;
			if (intent === "stopped") run.transition("stopped", { error: message });
			else if (intent === "aborted")
				run.transition("aborted", { error: message });
			else run.transition("error", { error: message });
		}
	} finally {
		tracker.unsubscribe();
		try {
			onTerminal?.(run);
		} catch {
			// A terminal hook must never mask the run outcome.
		}
		run.disposeChild();
	}
}

/**
 * Main-agent spawns produce exactly one child. Admission happens before any
 * session, file, or network work; a refusal throws and creates no run record.
 */
export async function spawnSubagent(
	request: SpawnRequest,
): Promise<SubagentRun> {
	const agentDir = request.agentDir ?? getAgentDir();
	const resolved = resolveChildModel({
		lookup: request.lookup,
		parentModel: request.parentModel,
		parentThinking: request.parentThinking,
		invocation: request.invocation,
	});
	const extensionRefs = resolveApprovedExtensionRefs(
		request.config,
		request.definition,
		request.extensions,
	);

	const policy: ToolPolicy = {
		included: Object.freeze([...(request.includedTools ?? [])]),
		excluded: Object.freeze([...(request.excludedTools ?? [])]),
	};

	const modelName =
		request.parentModel && resolved.model.id !== request.parentModel.id
			? shortModelLabel(resolved.model)
			: undefined;

	const id = createRunId();
	const run = new SubagentRun({
		id,
		subagentType: request.definition.name,
		displayName: request.definition.displayName ?? request.definition.name,
		description: request.description,
		parentSessionId: request.parentSessionId,
		toolCallId: request.toolCallId,
		maxTurns: request.invocation.maxTurns,
		modelName,
		tags: buildTags(request.definition, request.invocation),
		// Every child is a background session so Paseo learns its transcript path
		// at spawn and streams it live.
		initialStatus: "background",
	});

	const sessionManager = createChildSessionManager(request.cwd, agentDir, id);
	const outputFile = sessionManager.getSessionFile();
	if (outputFile && !isWireSafePath(outputFile)) {
		throw new AgentAdmissionError(
			`refusing a transcript path with whitespace: ${outputFile}`,
		);
	}
	run.outputFile = outputFile;

	const instructions = agentInstructions(request.definition);
	const resourceLoader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir,
		extensionFactories: [
			createCodemodeExtension({ mode: "on" }),
			createToolSearchExtension(),
			createMcpExtension(),
		],
		additionalExtensionPaths: [
			...extensionRefs,
			resolveSelfExtensionPath(request.selfExtensionPath),
		],
		appendSystemPrompt: instructions ? [instructions] : undefined,
	});
	await resourceLoader.reload();

	const settingsManager = SettingsManager.create(request.cwd, agentDir);
	// Session-local activation only; never saved to global settings.
	settingsManager.applyOverrides({
		defaultTools: ["+codemode", "+tool_search"],
	});

	const { session } = await createAgentSession({
		cwd: request.cwd,
		agentDir,
		model: resolved.model,
		thinkingLevel: resolved.thinking,
		resourceLoader,
		settingsManager,
		sessionManager,
	});

	const childSessionId = sessionManager.getSessionId();
	const lineage = childLineage(
		{
			sessionId: request.parentSessionId,
			depth: request.parentDepth,
			ceiling: request.parentCeiling,
		},
		childSessionId,
		{ runId: id, policy, agentMaxDepth: request.definition.maxDepth },
	);
	const lineageRegistry = getLineageRegistry();
	lineageRegistry.register(lineage);
	run.attachChild(session, () => {
		lineageRegistry.delete(childSessionId);
		request.onChildDisposed?.(childSessionId);
		session.dispose();
	});
	request.onChildCreated?.(childSessionId);

	// bindExtensions emits session_start, which connects MCP and lets the
	// child's own extension instance read this lineage.
	try {
		await runWithLineage(lineage, () => session.bindExtensions({}));
		assertEffectiveChild(session, resolved);
	} catch (error) {
		run.disposeChild();
		if (error instanceof AgentAdmissionError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new AgentAdmissionError(`child setup refused: ${message}`);
	}

	getRunRegistry().add(run);
	void runWithLineage(lineage, () =>
		runChild(
			run,
			session,
			request.prompt,
			request.invocation.maxTurns,
			request.onTerminal,
		),
	);

	return run;
}
