import { describe, expect, it, mock } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { EventEmitter } from "../src/events.ts";
import { type ManagerDeps, RunManager } from "../src/manager.ts";
import type { RunChildOptions, RunChildResult } from "../src/runner.ts";
import type { AgentDefinition, RunUsage, SuperAgentsConfig, TaskInput } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function zeroUsage(): RunUsage {
	return { turns: 1, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		slug: "scout",
		displayName: "Scout",
		description: "Explores code",
		body: "You are a scout.",
		tools: ["read"],
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

function agentsMap(...agents: AgentDefinition[]): Map<string, AgentDefinition> {
	return new Map(agents.map((a) => [a.slug, a]));
}

function makeTask(overrides: Partial<TaskInput> = {}): TaskInput {
	return { agent: "scout", prompt: "do the thing", ...overrides };
}

function config(overrides: Partial<SuperAgentsConfig> = {}): SuperAgentsConfig {
	return { ...DEFAULT_CONFIG, events: { ...DEFAULT_CONFIG.events }, ...overrides };
}

function makeCtx(): ExtensionContext {
	return {} as unknown as ExtensionContext;
}

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves quickly with a completed result; mirrors runner.ts's override-ignored semantics closely enough for validation tests. */
async function immediateRunChild(opts: RunChildOptions): Promise<RunChildResult> {
	const overrideIgnored =
		!opts.agent.allowModelOverride && (opts.task.model !== undefined || opts.task.thinking !== undefined);
	opts.onStarted({ model: opts.agent.model ?? "anthropic/claude-x", thinking: opts.agent.thinking, overrideIgnored });
	await Promise.resolve();
	return { status: "completed", text: `done:${opts.task.name ?? opts.agent.slug}`, usage: zeroUsage() };
}

/** A fake runChild whose calls stay pending until resolved manually via `resolveNext`, and which honors abort. */
function makeControllableRunChild() {
	const pending: Array<{ opts: RunChildOptions; resolve: (r: RunChildResult) => void }> = [];
	const startOrder: string[] = [];
	let active = 0;
	let maxActive = 0;

	const runChild = async (opts: RunChildOptions): Promise<RunChildResult> => {
		if (opts.signal.aborted) {
			return { status: "aborted", text: "", usage: zeroUsage() };
		}
		opts.onStarted({ model: "anthropic/claude-x", thinking: undefined, overrideIgnored: false });
		active += 1;
		maxActive = Math.max(maxActive, active);
		startOrder.push(opts.task.name ?? opts.agent.slug);
		try {
			return await new Promise<RunChildResult>((resolve) => {
				const item = { opts, resolve };
				pending.push(item);
				opts.signal.addEventListener(
					"abort",
					() => {
						const idx = pending.indexOf(item);
						if (idx !== -1) pending.splice(idx, 1);
						resolve({ status: "aborted", text: "", usage: zeroUsage() });
					},
					{ once: true },
				);
			});
		} finally {
			active -= 1;
		}
	};

	const resolveNext = (result: Partial<RunChildResult> = {}) => {
		const item = pending.shift();
		if (!item) throw new Error("no pending runChild call to resolve");
		item.resolve({ status: "completed", text: "ok", usage: zeroUsage(), ...result });
	};

	return {
		runChild,
		pending,
		startOrder,
		get maxActive() {
			return maxActive;
		},
		resolveNext,
	};
}

function makeDeps(overrides: Partial<ManagerDeps> = {}): {
	deps: ManagerDeps;
	append: ReturnType<typeof mock>;
	pushResult: ReturnType<typeof mock>;
} {
	const append = mock((_customType: string, _data: unknown) => {});
	const emitter = new EventEmitter({ append, config: config() });
	const pushResult = mock((_text: string, _details: unknown) => {});
	const deps: ManagerDeps = {
		config: config(),
		getAgents: () => agentsMap(makeAgent()),
		runChild: immediateRunChild,
		emitter,
		pushResult,
		cwd: "/tmp/proj",
		agentDir: "/tmp/agentdir",
		ownPackageDir: "/tmp/own",
		parentSessionId: "parent-1",
		overflowRoot: "/tmp/overflow",
		warn: () => {},
		...overrides,
	};
	return { deps, append, pushResult };
}

// ---------------------------------------------------------------------------
// startTasks validation
// ---------------------------------------------------------------------------

describe("RunManager.startTasks validation", () => {
	it("throws when tasks.length is 0", () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		expect(() => manager.startTasks({ tasks: [], background: false, parentToolCallId: "tc1", ctx: makeCtx() })).toThrow(
			/1 to 8/,
		);
	});

	it("throws when tasks.length exceeds maxTasksPerCall", () => {
		const { deps } = makeDeps({ config: config({ maxTasksPerCall: 2 }) });
		const manager = new RunManager(deps);
		const tasks = [makeTask(), makeTask(), makeTask()];
		expect(() => manager.startTasks({ tasks, background: false, parentToolCallId: "tc1", ctx: makeCtx() })).toThrow(
			/expected 1 to 2 tasks per call, got 3/,
		);
	});

	it("throws a clear error listing available agents for an unknown agent", () => {
		const { deps } = makeDeps({
			getAgents: () => agentsMap(makeAgent({ slug: "scout" }), makeAgent({ slug: "writer" })),
		});
		const manager = new RunManager(deps);
		expect(() =>
			manager.startTasks({
				tasks: [makeTask({ agent: "ghost" })],
				background: false,
				parentToolCallId: "tc1",
				ctx: makeCtx(),
			}),
		).toThrow("unknown agent 'ghost'. Available: scout, writer");
	});

	it("throws when prompt is empty after trim", () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		expect(() =>
			manager.startTasks({
				tasks: [makeTask({ prompt: "   " })],
				background: false,
				parentToolCallId: "tc1",
				ctx: makeCtx(),
			}),
		).toThrow(/prompt must not be empty/);
	});

	it("validates all tasks before starting any (fails the whole call on first problem)", () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		expect(() =>
			manager.startTasks({
				tasks: [makeTask(), makeTask({ agent: "ghost" })],
				background: false,
				parentToolCallId: "tc1",
				ctx: makeCtx(),
			}),
		).toThrow(/unknown agent/);
		// Nothing should have been recorded from the failed batch.
		expect(manager.status()).toEqual([]);
	});

	it("does not fail validation on a disallowed model/thinking override; the run proceeds with overrideIgnored set", async () => {
		const { deps } = makeDeps({ getAgents: () => agentsMap(makeAgent({ allowModelOverride: false })) });
		const manager = new RunManager(deps);
		const { records, done } = manager.startTasks({
			tasks: [makeTask({ model: "openai/gpt-5", thinking: "high" })],
			background: false,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await done;
		expect(records[0].status).toBe("completed");
		expect(records[0].overrideIgnored).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Name / id generation
// ---------------------------------------------------------------------------

describe("RunManager.startTasks id/name generation", () => {
	it("generates 8-char [a-z0-9] ids, unique across a large batch", async () => {
		const { deps } = makeDeps({ config: config({ maxTasksPerCall: 30 }) });
		const manager = new RunManager(deps);
		const tasks = Array.from({ length: 30 }, (_, i) => makeTask({ name: `t${i}` }));
		const { records, done } = manager.startTasks({ tasks, background: false, parentToolCallId: "tc1", ctx: makeCtx() });
		await done;

		const ids = records.map((r) => r.id);
		for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("dedupes names within the same batch with -2, -3 suffixes", async () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		const tasks = [makeTask({ name: "dup" }), makeTask({ name: "dup" }), makeTask({ name: "dup" })];
		const { records, done } = manager.startTasks({ tasks, background: false, parentToolCallId: "tc1", ctx: makeCtx() });
		await done;
		expect(records.map((r) => r.name)).toEqual(["dup", "dup-2", "dup-3"]);
	});

	it("defaults name to the agent slug when task.name is omitted", async () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		const { records, done } = manager.startTasks({
			tasks: [makeTask()],
			background: false,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await done;
		expect(records[0].name).toBe("scout");
	});

	it("dedupes a new batch's name against an earlier non-finished run", async () => {
		const controllable = makeControllableRunChild();
		const { deps } = makeDeps({ runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const first = manager.startTasks({
			tasks: [makeTask({ name: "dup" })],
			background: true,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await tick();
		expect(first.records[0].status).toBe("running");

		const second = manager.startTasks({
			tasks: [makeTask({ name: "dup" })],
			background: true,
			parentToolCallId: "tc2",
			ctx: makeCtx(),
		});
		expect(second.records[0].name).toBe("dup-2");
		await tick();

		controllable.resolveNext();
		controllable.resolveNext();
		await Promise.all([first.done, second.done]);
	});
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("RunManager.startTasks concurrency", () => {
	it("never runs more than maxConcurrent fake runs at once, and starts queued runs in FIFO order", async () => {
		const controllable = makeControllableRunChild();
		const { deps } = makeDeps({ config: config({ maxConcurrent: 2 }), runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const tasks = [1, 2, 3, 4].map((i) => makeTask({ name: `task-${i}` }));
		const { records, done } = manager.startTasks({ tasks, background: false, parentToolCallId: "tc1", ctx: makeCtx() });
		await tick();

		expect(controllable.maxActive).toBe(2);
		expect(records.map((r) => r.status)).toEqual(["running", "running", "queued", "queued"]);

		controllable.resolveNext(); // releases task-1's slot
		await tick();
		expect(controllable.startOrder).toEqual(["task-1", "task-2", "task-3"]);
		expect(records.map((r) => r.status)).toEqual(["completed", "running", "running", "queued"]);

		controllable.resolveNext();
		controllable.resolveNext();
		await tick();
		expect(controllable.startOrder).toEqual(["task-1", "task-2", "task-3", "task-4"]);

		controllable.resolveNext();
		await done;
		expect(controllable.maxActive).toBe(2);
		expect(records.every((r) => r.status === "completed")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Foreground abort cascading
// ---------------------------------------------------------------------------

describe("RunManager.startTasks foreground abort", () => {
	it("aborting the passed-in signal aborts every record of the call, including queued ones", async () => {
		const controllable = makeControllableRunChild();
		const { deps } = makeDeps({ config: config({ maxConcurrent: 1 }), runChild: controllable.runChild });
		const manager = new RunManager(deps);
		const controller = new AbortController();

		const tasks = [1, 2, 3].map((i) => makeTask({ name: `task-${i}` }));
		const { records, done } = manager.startTasks({
			tasks,
			background: false,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
			signal: controller.signal,
		});
		await tick();
		expect(records[0].status).toBe("running");
		expect(records[1].status).toBe("queued");
		expect(records[2].status).toBe("queued");

		controller.abort();
		await done;

		expect(records.every((r) => r.status === "aborted")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Background push batching
// ---------------------------------------------------------------------------

describe("RunManager background push", () => {
	it("batches two near-simultaneous background completions into a single pushResult call", async () => {
		const controllable = makeControllableRunChild();
		const { deps, pushResult } = makeDeps({ config: config({ maxConcurrent: 2 }), runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const tasks = [makeTask({ name: "a" }), makeTask({ name: "b" })];
		manager.startTasks({ tasks, background: true, parentToolCallId: "tc1", ctx: makeCtx() });
		await tick();

		controllable.resolveNext();
		controllable.resolveNext();
		await tick(300); // past BACKGROUND_BATCH_MS

		expect(pushResult).toHaveBeenCalledTimes(1);
		const [text, details] = pushResult.mock.calls[0] as [string, { runs: unknown[] }];
		expect(text).toContain("Background sub-agent results:");
		expect(details.runs).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// wait()
// ---------------------------------------------------------------------------

describe("RunManager.wait", () => {
	it("returns finished results and suppresses the later background push", async () => {
		const controllable = makeControllableRunChild();
		const { deps, pushResult } = makeDeps({ runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const { records } = manager.startTasks({
			tasks: [makeTask({ name: "a" })],
			background: true,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await tick();

		const waitPromise = manager.wait([records[0].id], 5000);
		controllable.resolveNext();
		const { finished, pending } = await waitPromise;

		expect(finished).toHaveLength(1);
		expect(finished[0].id).toBe(records[0].id);
		expect(finished[0].delivered).toBe(true);
		expect(pending).toEqual([]);

		await tick(300); // past BACKGROUND_BATCH_MS
		expect(pushResult).not.toHaveBeenCalled();
	});

	it("times out and returns the still-running record as pending", async () => {
		const controllable = makeControllableRunChild();
		const { deps } = makeDeps({ runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const { records } = manager.startTasks({
			tasks: [makeTask({ name: "a" })],
			background: true,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await tick();

		const { finished, pending } = await manager.wait([records[0].id], 20);
		expect(finished).toEqual([]);
		expect(pending).toHaveLength(1);
		expect(pending[0].id).toBe(records[0].id);
		expect(pending[0].delivered).toBe(false);

		controllable.resolveNext();
	});

	it("throws for unknown ids", () => {
		const { deps } = makeDeps();
		const manager = new RunManager(deps);
		expect(manager.wait(["nope"], 10)).rejects.toThrow(/unknown agent id\(s\): nope/);
	});
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe("RunManager.stop", () => {
	it("stops by id, by name, reports already-finished and not-found", async () => {
		const controllable = makeControllableRunChild();
		const { deps } = makeDeps({ config: config({ maxConcurrent: 3 }), runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const tasks = [makeTask({ name: "finished" }), makeTask({ name: "by-id" }), makeTask({ name: "by-name" })];
		const { records, done } = manager.startTasks({ tasks, background: true, parentToolCallId: "tc1", ctx: makeCtx() });
		await tick();

		controllable.resolveNext({ status: "completed" }); // finishes "finished", submitted first
		await tick();

		const result = manager.stop([records[1].id, "by-name", records[0].name, "ghost"]);

		expect(result.stopped).toContain(records[1].id);
		expect(result.stopped).toContain("by-name");
		expect(result.alreadyFinished).toContain(records[0].name);
		expect(result.notFound).toEqual(["ghost"]);

		// stop() aborted "by-id" and "by-name"; their fake runChild calls resolve themselves via the abort listener.
		await done;
	});
});

// ---------------------------------------------------------------------------
// shutdown()
// ---------------------------------------------------------------------------

describe("RunManager.shutdown", () => {
	it("aborts running runs and never pushes their results", async () => {
		const controllable = makeControllableRunChild();
		const { deps, pushResult } = makeDeps({ runChild: controllable.runChild });
		const manager = new RunManager(deps);

		const { records } = manager.startTasks({
			tasks: [makeTask({ name: "a" })],
			background: true,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await tick();
		expect(records[0].status).toBe("running");

		manager.shutdown();
		await tick(300); // past BACKGROUND_BATCH_MS

		expect(records[0].status).toBe("aborted");
		expect(pushResult).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Lifecycle event ordering
// ---------------------------------------------------------------------------

describe("RunManager lifecycle events", () => {
	it("emits queued, then started, then finished for a single run", async () => {
		const { deps, append } = makeDeps();
		const manager = new RunManager(deps);
		const { done } = manager.startTasks({
			tasks: [makeTask()],
			background: false,
			parentToolCallId: "tc1",
			ctx: makeCtx(),
		});
		await done;

		const phases = append.mock.calls
			.map(([, data]) => data as { kind: string; phase?: string })
			.filter((d) => d.kind === "lifecycle")
			.map((d) => d.phase);
		expect(phases).toEqual(["queued", "started", "finished"]);
	});
});
