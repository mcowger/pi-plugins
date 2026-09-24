import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CHILD_PROMPT_FOOTER, OWN_TOOL_NAMES, TURN_LIMIT_STEER } from "./constants.ts";
import { filterExtensions } from "./extension-names.ts";
import type { AgentDefinition, RunUsage, TaskInput } from "./types.ts";

// biome-ignore lint/suspicious/noExplicitAny: mirrors the SDK's own Model<any> typing (Api is not exposed to extensions)
type AnyModel = Model<any>;

/**
 * Builds an actionable error for an unresolvable `provider/id` model string. Distinguishes
 * "provider unknown in this session" (likely an extension whose provider registration never
 * reached this session) from "provider known, model id unknown" (likely a typo), since the two
 * have very different fixes.
 */
function describeModelNotFound(
	modelStr: string,
	provider: string,
	id: string,
	hasProvider: ((provider: string) => boolean) | undefined,
	listProviders: (() => readonly string[]) | undefined,
): string {
	if (hasProvider === undefined) return `model '${modelStr}' not found`;
	if (hasProvider(provider)) {
		return `model '${modelStr}' not found: provider '${provider}' is registered but has no model '${id}'. Check for a typo in the model id.`;
	}
	const known = listProviders?.() ?? [];
	const knownText = known.length > 0 ? ` Providers registered in this session: ${known.join(", ")}.` : "";
	return (
		`model '${modelStr}' not found: provider '${provider}' is not registered in this session.${knownText} ` +
		`If '${provider}' is supplied by a pi extension, make sure that extension is loaded in the parent session ` +
		"(the parent must not be started with --no-extensions) — sub-agents share the parent's registered " +
		"providers automatically and do not need to load the extension themselves."
	);
}

export function resolveModelChoice(input: {
	agent: AgentDefinition;
	task: TaskInput;
	parentModel: AnyModel | undefined;
	parentThinking: ThinkingLevel | undefined;
	find: (provider: string, id: string) => AnyModel | undefined;
	hasProvider?: (provider: string) => boolean;
	listProviders?: () => readonly string[];
}): { model: AnyModel; thinking: ThinkingLevel | undefined; overrideIgnored: boolean } {
	const { agent, task, parentModel, parentThinking, find, hasProvider, listProviders } = input;

	// Step 1: if the agent disallows overrides, treat the task's requested
	// model/thinking as unset (never throw for a disallowed request).
	let taskModel = task.model;
	let taskThinking = task.thinking;
	let overrideIgnored = false;
	if (!agent.allowModelOverride) {
		overrideIgnored = taskModel !== undefined || taskThinking !== undefined;
		taskModel = undefined;
		taskThinking = undefined;
	}

	// Step 2: resolve the model.
	const modelStr = taskModel ?? agent.model;
	let model: AnyModel;
	if (modelStr !== undefined) {
		const slashIndex = modelStr.indexOf("/");
		const provider = modelStr.slice(0, slashIndex);
		const id = modelStr.slice(slashIndex + 1);
		const found = find(provider, id);
		if (!found) throw new Error(describeModelNotFound(modelStr, provider, id, hasProvider, listProviders));
		model = found;
	} else if (parentModel !== undefined) {
		model = parentModel;
	} else {
		throw new Error("no model available (parent has no model selected)");
	}

	// Step 3: resolve thinking level.
	const thinking = taskThinking ?? agent.thinking ?? parentThinking;

	return { model, thinking, overrideIgnored };
}

export interface RunChildOptions {
	agent: AgentDefinition;
	task: TaskInput;
	cwd: string;
	agentDir: string;
	ctx: ExtensionContext;
	ownPackageDir: string;
	graceTurns: number;
	signal: AbortSignal;
	onEvent: (event: AgentSessionEvent) => void;
	onStarted: (info: { model: string; thinking?: ThinkingLevel; overrideIgnored: boolean }) => void;
	warn: (message: string) => void;
}

export interface RunChildResult {
	status: "completed" | "failed" | "aborted" | "turn_limited";
	text: string;
	error?: string;
	usage: RunUsage;
}

const ZERO_USAGE: RunUsage = {
	turns: 0,
	toolCalls: 0,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
};

export async function runChild(opts: RunChildOptions): Promise<RunChildResult> {
	const { agent, task, cwd, agentDir, ctx, ownPackageDir, graceTurns, signal, onEvent, onStarted, warn } = opts;

	let session: AgentSession | undefined;
	let unsub: (() => void) | undefined;
	let abortListenerAdded = false;
	let turns = 0;
	let turnLimited = false;
	let forcedAbort = false;

	const onAbort = () => {
		void session?.abort().catch(() => {});
	};

	try {
		// 1. Resolve model/thinking.
		const { model, thinking, overrideIgnored } = resolveModelChoice({
			agent,
			task,
			parentModel: ctx.model,
			parentThinking: ctx.thinkingLevel,
			find: (p, id) => ctx.modelRegistry.find(p, id),
			hasProvider: (p) => ctx.modelRegistry.getProvider(p) !== undefined,
			listProviders: () => ctx.modelRegistry.getRegisteredProviderIds(),
		});

		// 2. Settings manager.
		const settingsManager = SettingsManager.create(cwd, agentDir);

		// 3. Resource loader.
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: agent.extensions === "none",
			noSkills: agent.skills === "none",
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !agent.contextFiles,
			extensionsOverride: (base) => {
				const { kept, unmatched } = filterExtensions(
					base.extensions,
					agent.extensions,
					agent.excludeExtensions,
					ownPackageDir,
				);
				for (const n of unmatched) warn(`agent '${agent.slug}': extension '${n}' not found`);
				return { ...base, extensions: kept };
			},
			skillsOverride: Array.isArray(agent.skills)
				? (base) => ({ ...base, skills: base.skills.filter((s) => (agent.skills as string[]).includes(s.name)) })
				: undefined,
			systemPromptOverride:
				agent.systemPromptMode === "replace"
					? () => [agent.body, CHILD_PROMPT_FOOTER].filter(Boolean).join("\n\n")
					: undefined,
			appendSystemPromptOverride:
				agent.systemPromptMode === "append"
					? (base) => [...base, [agent.body, CHILD_PROMPT_FOOTER].filter(Boolean).join("\n\n")]
					: undefined,
		});
		await loader.reload();

		// 4. Shared model runtime, when reachable.
		const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;

		// 5. Tool allowlist.
		const excludeTools = [...agent.excludeTools, ...OWN_TOOL_NAMES];
		const tools = agent.tools.filter((t) => !excludeTools.includes(t));

		// 6. Create the child session.
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
			tools,
			excludeTools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			...(modelRuntime ? { modelRuntime } : {}),
		});
		session = created.session;

		// 7. Cosmetic session name.
		session.setSessionName(`${agent.slug}:${task.name ?? ""}`);

		// 8. Bind extensions.
		await session.bindExtensions({
			onError: (e) => warn(`agent '${agent.slug}' extension error: ${e.extensionPath}: ${e.error}`),
		});

		// 9. Re-enforce the tool set after extensions bound.
		const available = new Set(session.getAllTools().map((t) => t.name));
		for (const t of tools) {
			if (!available.has(t)) warn(`agent '${agent.slug}': tool '${t}' not available`);
		}
		session.setActiveToolsByName(tools.filter((t) => available.has(t)));

		// 10. Notify caller the run started.
		onStarted({ model: `${model.provider}/${model.id}`, thinking: session.thinkingLevel, overrideIgnored });

		// 11-12. Subscribe and track turns for max_turns enforcement.
		unsub = session.subscribe((e) => {
			try {
				onEvent(e);
			} catch {
				// never let a caller's event handler break the run
			}

			if (e.type === "turn_end") {
				turns += 1;
				if (agent.maxTurns !== undefined) {
					if (turns === agent.maxTurns) {
						turnLimited = true;
						void session?.steer(TURN_LIMIT_STEER).catch(() => {});
					}
					if (turns >= agent.maxTurns + graceTurns && !forcedAbort) {
						forcedAbort = true;
						void session?.abort().catch(() => {});
					}
				}
			}
		});

		// 13-14. Abort wiring and prompt.
		let caughtError: string | undefined;
		if (!signal.aborted) {
			signal.addEventListener("abort", onAbort, { once: true });
			abortListenerAdded = true;
			try {
				await session.prompt(task.prompt);
			} catch (err) {
				caughtError = err instanceof Error ? err.message : String(err);
			}
		}

		// 15. Determine the result.
		const text = session.getLastAssistantText() ?? "";

		let modelError: string | undefined;
		const messages = session.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") {
				if (m.stopReason === "error") {
					modelError = m.errorMessage ?? "model error";
				}
				break;
			}
		}

		let status: RunChildResult["status"];
		let error: string | undefined;
		if (signal.aborted) {
			status = "aborted";
		} else if (forcedAbort) {
			status = "turn_limited";
		} else if (caughtError !== undefined || modelError !== undefined) {
			status = "failed";
			error = caughtError ?? modelError;
		} else if (turnLimited) {
			status = "turn_limited";
		} else {
			status = "completed";
		}

		const stats = session.getSessionStats();
		const usage: RunUsage = { turns, toolCalls: stats.toolCalls, tokens: stats.tokens, cost: stats.cost };

		return { status, text, error, usage };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { status: "failed", error: message, text: "", usage: { ...ZERO_USAGE, turns } };
	} finally {
		if (unsub) unsub();
		if (abortListenerAdded) signal.removeEventListener("abort", onAbort);
		if (session) {
			try {
				session.dispose();
			} catch {
				// ignore dispose errors
			}
		}
	}
}
