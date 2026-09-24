import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { CHILD_PROMPT_FOOTER, OWN_TOOL_NAMES } from "../src/constants.ts";
import type { AgentDefinition, TaskInput } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fake @earendil-works/pi-coding-agent
// ---------------------------------------------------------------------------

interface FakeSessionScript {
	events?: AgentSessionEvent[];
	promptImpl?: (text: string) => Promise<void>;
	lastAssistantText?: string;
	messages?: unknown[];
	stats?: {
		toolCalls: number;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		cost: number;
	};
	availableToolNames?: string[];
}

class FakeAgentSession {
	calls = {
		steer: [] as string[],
		abort: 0,
		dispose: 0,
		setActiveToolsByName: [] as string[][],
		setSessionName: [] as string[],
		bindExtensions: [] as unknown[],
		prompt: 0,
	};
	listeners: Array<(e: AgentSessionEvent) => void> = [];
	thinkingLevel: string | undefined;
	model: unknown;

	constructor(
		private script: FakeSessionScript,
		model: unknown,
		thinkingLevel: string | undefined,
	) {
		this.model = model;
		this.thinkingLevel = thinkingLevel ?? "medium";
	}

	subscribe(listener: (e: AgentSessionEvent) => void) {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	async bindExtensions(bindings: unknown) {
		this.calls.bindExtensions.push(bindings);
	}

	getActiveToolNames() {
		return [];
	}

	getAllTools() {
		return (this.script.availableToolNames ?? []).map((name) => ({ name }));
	}

	setActiveToolsByName(names: string[]) {
		this.calls.setActiveToolsByName.push(names);
	}

	setSessionName(name: string) {
		this.calls.setSessionName.push(name);
	}

	async prompt(text: string) {
		this.calls.prompt += 1;
		if (this.script.promptImpl) {
			await this.script.promptImpl(text);
			return;
		}
		for (const e of this.script.events ?? []) {
			for (const l of [...this.listeners]) l(e);
		}
	}

	async steer(text: string) {
		this.calls.steer.push(text);
	}

	async abort() {
		this.calls.abort += 1;
	}

	dispose() {
		this.calls.dispose += 1;
	}

	getLastAssistantText() {
		return this.script.lastAssistantText;
	}

	get messages() {
		return this.script.messages ?? [];
	}

	getSessionStats() {
		return (
			this.script.stats ?? {
				toolCalls: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}
		);
	}
}

let currentScript: FakeSessionScript = {};
// biome-ignore lint/suspicious/noExplicitAny: captures whatever createAgentSession/DefaultResourceLoader were called with, for assertions
let lastCreateOptions: any = null;
// biome-ignore lint/suspicious/noExplicitAny: see above
let lastLoaderOptions: any = null;
let lastSession: FakeAgentSession | null = null;
let createAgentSessionShouldThrow: Error | null = null;

mock.module("@earendil-works/pi-coding-agent", () => ({
	// biome-ignore lint/suspicious/noExplicitAny: fake mirrors CreateAgentSessionOptions loosely for test purposes
	createAgentSession: async (options: any) => {
		lastCreateOptions = options;
		if (createAgentSessionShouldThrow) throw createAgentSessionShouldThrow;
		const session = new FakeAgentSession(currentScript, options.model, options.thinkingLevel);
		lastSession = session;
		return { session, extensionsResult: { extensions: [], errors: [], runtime: {} } };
	},
	DefaultResourceLoader: class {
		// biome-ignore lint/suspicious/noExplicitAny: see above
		constructor(options: any) {
			lastLoaderOptions = options;
		}
		async reload() {}
	},
	SessionManager: {
		inMemory: (cwd?: string) => ({ __fake: "sessionManager", cwd }),
	},
	SettingsManager: {
		create: (cwd: string, agentDir?: string) => ({ __fake: "settingsManager", cwd, agentDir }),
	},
}));

afterAll(() => {
	mock.restore();
});

// biome-ignore lint/suspicious/noExplicitAny: runner.test's whole point is to bypass the SDK's real generics
const { resolveModelChoice, runChild } = (await import("../src/runner.ts")) as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		slug: "scout",
		displayName: "Scout",
		description: "Explores code",
		body: "You are a scout.",
		tools: ["read", "grep"],
		excludeTools: [],
		extensions: "none",
		excludeExtensions: [],
		skills: "none",
		contextFiles: false,
		systemPromptMode: "append",
		model: undefined,
		thinking: undefined,
		allowModelOverride: false,
		maxTurns: undefined,
		source: "user",
		filePath: "/agents/scout.md",
		...overrides,
	};
}

function makeTask(overrides: Partial<TaskInput> = {}): TaskInput {
	return { agent: "scout", prompt: "do the thing", ...overrides };
}

// biome-ignore lint/suspicious/noExplicitAny: stand-in for Model<any>
function makeModel(overrides: Record<string, any> = {}): any {
	return {
		provider: "anthropic",
		id: "claude-x",
		name: "Claude X",
		api: "anthropic-messages",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
		...overrides,
	};
}

// biome-ignore lint/suspicious/noExplicitAny: stand-in for ExtensionContext
function makeCtx(overrides: Record<string, any> = {}): any {
	return {
		cwd: "/tmp/proj",
		model: makeModel(),
		thinkingLevel: "medium",
		modelRegistry: { find: () => undefined },
		sessionManager: { getSessionId: () => "sess-1" },
		isIdle: () => true,
		signal: undefined,
		hasUI: false,
		ui: { notify: () => {} },
		...overrides,
	};
}

function turnEnd(): AgentSessionEvent {
	return { type: "turn_end", message: {}, toolResults: [] } as unknown as AgentSessionEvent;
}

beforeEach(() => {
	currentScript = {};
	lastCreateOptions = null;
	lastLoaderOptions = null;
	lastSession = null;
	createAgentSessionShouldThrow = null;
});

// ---------------------------------------------------------------------------
// resolveModelChoice
// ---------------------------------------------------------------------------

describe("resolveModelChoice", () => {
	it("ignores a requested override and reports overrideIgnored when the agent disallows it", () => {
		const parentModel = makeModel({ id: "parent-model" });
		const result = resolveModelChoice({
			agent: makeAgent({ allowModelOverride: false, model: undefined }),
			task: makeTask({ model: "openai/gpt", thinking: "high" }),
			parentModel,
			parentThinking: "low",
			find: () => makeModel({ id: "should-not-be-used" }),
		});
		expect(result.model).toBe(parentModel);
		expect(result.overrideIgnored).toBe(true);
	});

	it("does not report overrideIgnored when disallowed but nothing was requested", () => {
		const parentModel = makeModel();
		const result = resolveModelChoice({
			agent: makeAgent({ allowModelOverride: false }),
			task: makeTask(),
			parentModel,
			parentThinking: undefined,
			find: () => undefined,
		});
		expect(result.overrideIgnored).toBe(false);
	});

	it("applies the requested override when the agent allows it", () => {
		const overrideModel = makeModel({ id: "override-model" });
		const found = mock((provider: string, id: string) =>
			provider === "openai" && id === "gpt-5" ? overrideModel : undefined,
		);
		const result = resolveModelChoice({
			agent: makeAgent({ allowModelOverride: true }),
			task: makeTask({ model: "openai/gpt-5" }),
			parentModel: makeModel(),
			parentThinking: undefined,
			find: found,
		});
		expect(result.model).toBe(overrideModel);
		expect(result.overrideIgnored).toBe(false);
		expect(found).toHaveBeenCalledWith("openai", "gpt-5");
	});

	it("uses the frontmatter-pinned model when no override is requested", () => {
		const pinned = makeModel({ id: "pinned" });
		const result = resolveModelChoice({
			agent: makeAgent({ model: "anthropic/pinned" }),
			task: makeTask(),
			parentModel: makeModel({ id: "parent" }),
			parentThinking: undefined,
			find: (provider: string, id: string) => (provider === "anthropic" && id === "pinned" ? pinned : undefined),
		});
		expect(result.model).toBe(pinned);
	});

	it("throws when the resolved model string cannot be found", () => {
		expect(() =>
			resolveModelChoice({
				agent: makeAgent({ model: "anthropic/does-not-exist" }),
				task: makeTask(),
				parentModel: makeModel(),
				parentThinking: undefined,
				find: () => undefined,
			}),
		).toThrow("model 'anthropic/does-not-exist' not found");
	});

	it("inherits the parent model when neither task nor agent specify one", () => {
		const parentModel = makeModel({ id: "inherited" });
		const result = resolveModelChoice({
			agent: makeAgent(),
			task: makeTask(),
			parentModel,
			parentThinking: undefined,
			find: () => undefined,
		});
		expect(result.model).toBe(parentModel);
	});

	it("throws when no model is available anywhere", () => {
		expect(() =>
			resolveModelChoice({
				agent: makeAgent(),
				task: makeTask(),
				parentModel: undefined,
				parentThinking: undefined,
				find: () => undefined,
			}),
		).toThrow("no model available (parent has no model selected)");
	});

	it("prefers task thinking, then agent thinking, then parent thinking", () => {
		const base = {
			agent: makeAgent({ allowModelOverride: true, thinking: "low", model: "a/b" }),
			find: () => makeModel(),
		};

		expect(
			resolveModelChoice({
				...base,
				task: makeTask({ thinking: "high" }),
				parentModel: undefined,
				parentThinking: "off",
			}).thinking,
		).toBe("high");

		expect(
			resolveModelChoice({ ...base, task: makeTask(), parentModel: undefined, parentThinking: "off" }).thinking,
		).toBe("low");

		expect(
			resolveModelChoice({
				...base,
				agent: makeAgent({ allowModelOverride: true, thinking: undefined, model: "a/b" }),
				task: makeTask(),
				parentModel: undefined,
				parentThinking: "off",
			}).thinking,
		).toBe("off");
	});

	it("ignores requested thinking override when the agent disallows overrides, even with agent thinking unset", () => {
		const result = resolveModelChoice({
			agent: makeAgent({ allowModelOverride: false, thinking: undefined, model: "a/b" }),
			task: makeTask({ thinking: "xhigh" }),
			parentModel: undefined,
			parentThinking: "off",
			find: () => makeModel(),
		});
		expect(result.thinking).toBe("off");
		expect(result.overrideIgnored).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runChild
// ---------------------------------------------------------------------------

function baseOptions(overrides: Record<string, unknown> = {}) {
	const controller = new AbortController();
	return {
		agent: makeAgent(),
		task: makeTask(),
		cwd: "/tmp/proj",
		agentDir: "/tmp/agentdir",
		ctx: makeCtx(),
		ownPackageDir: "/tmp/own",
		graceTurns: 3,
		signal: controller.signal,
		onEvent: () => {},
		onStarted: () => {},
		warn: () => {},
		...overrides,
	};
}

describe("runChild", () => {
	it("passes the filtered tool allowlist and always excludes own tool names", async () => {
		currentScript.availableToolNames = ["read", "grep"];
		const agent = makeAgent({ tools: ["read", "grep", "agent"], excludeTools: ["grep"] });
		const result = await runChild(baseOptions({ agent }));

		expect(result.status).toBe("completed");
		expect(lastCreateOptions.tools).toEqual(["read"]);
		for (const own of OWN_TOOL_NAMES) {
			expect(lastCreateOptions.excludeTools).toContain(own);
		}
		expect(lastSession?.calls.setActiveToolsByName).toEqual([["read"]]);
	});

	it("warns and drops tools that never became available after extensions bound", async () => {
		currentScript.availableToolNames = ["read"];
		const warnings: string[] = [];
		const agent = makeAgent({ tools: ["read", "grep"] });
		await runChild(baseOptions({ agent, warn: (m: string) => warnings.push(m) }));

		expect(lastSession?.calls.setActiveToolsByName).toEqual([["read"]]);
		expect(warnings.some((w) => w.includes("'grep'") && w.includes("not available"))).toBe(true);
	});

	it("loads no extensions by default", async () => {
		await runChild(baseOptions({ agent: makeAgent({ extensions: "none" }) }));
		expect(lastLoaderOptions.noExtensions).toBe(true);
	});

	it("allows extensions to load when the agent opts in", async () => {
		await runChild(baseOptions({ agent: makeAgent({ extensions: "all" }) }));
		expect(lastLoaderOptions.noExtensions).toBe(false);
	});

	it("appends the agent body and footer via appendSystemPromptOverride in append mode", async () => {
		const agent = makeAgent({ systemPromptMode: "append", body: "You are a scout." });
		await runChild(baseOptions({ agent }));

		expect(lastLoaderOptions.systemPromptOverride).toBeUndefined();
		expect(typeof lastLoaderOptions.appendSystemPromptOverride).toBe("function");
		const appended = lastLoaderOptions.appendSystemPromptOverride(["existing prompt"]);
		expect(appended).toEqual(["existing prompt", `You are a scout.\n\n${CHILD_PROMPT_FOOTER}`]);
	});

	it("replaces the system prompt via systemPromptOverride in replace mode", async () => {
		const agent = makeAgent({ systemPromptMode: "replace", body: "You are a scout." });
		await runChild(baseOptions({ agent }));

		expect(lastLoaderOptions.appendSystemPromptOverride).toBeUndefined();
		expect(typeof lastLoaderOptions.systemPromptOverride).toBe("function");
		expect(lastLoaderOptions.systemPromptOverride()).toBe(`You are a scout.\n\n${CHILD_PROMPT_FOOTER}`);
	});

	it("steers at max_turns and force-aborts after graceTurns more turns", async () => {
		currentScript.events = [turnEnd(), turnEnd(), turnEnd()];
		const agent = makeAgent({ maxTurns: 2 });
		const result = await runChild(baseOptions({ agent, graceTurns: 1 }));

		expect(lastSession?.calls.steer).toHaveLength(1);
		expect(lastSession?.calls.abort).toBe(1);
		expect(result.status).toBe("turn_limited");
		expect(result.usage.turns).toBe(3);
	});

	it("never steers or force-aborts when max_turns is unset", async () => {
		currentScript.events = [turnEnd(), turnEnd(), turnEnd(), turnEnd(), turnEnd()];
		const result = await runChild(baseOptions({ agent: makeAgent({ maxTurns: undefined }) }));

		expect(lastSession?.calls.steer).toEqual([]);
		expect(lastSession?.calls.abort).toBe(0);
		expect(result.status).toBe("completed");
	});

	it("reports status aborted when the signal is already aborted before prompting", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runChild(baseOptions({ signal: controller.signal }));

		expect(result.status).toBe("aborted");
		expect(lastSession?.calls.prompt).toBe(0);
		expect(lastSession?.calls.dispose).toBe(1);
	});

	it("reports status aborted when the signal fires during the run", async () => {
		const controller = new AbortController();
		currentScript.promptImpl = async () => {
			controller.abort();
		};
		const result = await runChild(baseOptions({ signal: controller.signal }));

		expect(result.status).toBe("aborted");
		expect(lastSession?.calls.abort).toBe(1);
		expect(lastSession?.calls.dispose).toBe(1);
	});

	it("reports status failed (never throws) when the child session throws during prompt", async () => {
		currentScript.promptImpl = async () => {
			throw new Error("boom");
		};
		const result = await runChild(baseOptions());

		expect(result.status).toBe("failed");
		expect(result.error).toBe("boom");
		expect(lastSession?.calls.dispose).toBe(1);
	});

	it("reports status failed when the last assistant message stopped with an error", async () => {
		currentScript.messages = [{ role: "assistant", stopReason: "error", errorMessage: "provider exploded" }];
		const result = await runChild(baseOptions());

		expect(result.status).toBe("failed");
		expect(result.error).toBe("provider exploded");
	});

	it("never throws even when createAgentSession itself rejects", async () => {
		createAgentSessionShouldThrow = new Error("setup failed");
		const result = await runChild(baseOptions());

		expect(result.status).toBe("failed");
		expect(result.error).toBe("setup failed");
		expect(result.text).toBe("");
	});

	it("returns the completed status with usage and final text on the happy path", async () => {
		currentScript.lastAssistantText = "final answer";
		currentScript.stats = {
			toolCalls: 4,
			tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
			cost: 0.01,
		};
		currentScript.events = [turnEnd(), turnEnd()];
		const result = await runChild(baseOptions());

		expect(result.status).toBe("completed");
		expect(result.text).toBe("final answer");
		expect(result.usage).toEqual({
			turns: 2,
			toolCalls: 4,
			tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
			cost: 0.01,
		});
		expect(lastSession?.calls.dispose).toBe(1);
	});

	it("reports overrideIgnored via onStarted when the agent disallows a requested override", async () => {
		let started: { model: string; thinking?: string; overrideIgnored: boolean } | undefined;
		await runChild(
			baseOptions({
				agent: makeAgent({ allowModelOverride: false }),
				task: makeTask({ model: "openai/gpt-5" }),
				onStarted: (info: typeof started) => {
					started = info;
				},
			}),
		);
		expect(started?.overrideIgnored).toBe(true);
	});
});
