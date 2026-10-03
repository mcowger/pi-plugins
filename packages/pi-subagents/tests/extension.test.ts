import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piSubagents from "../index.js";
import { getLineageRegistry } from "../src/lineage.js";
import { getRunRegistry, SubagentRun } from "../src/run.js";
import { resolveToolPolicy } from "../src/selectors.js";

interface FakeTool {
	name: string;
	exposure?: string;
}

function createFakePi() {
	const tools = new Map<string, FakeTool>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const flags = new Map<string, boolean | string>();
	const active = new Set<string>([
		"read",
		"bash",
		"grep",
		"find",
		"ls",
		"Agent",
		"get_subagent_result",
		"steer_subagent",
	]);
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();

	const pi = {
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		registerFlag: (
			name: string,
			options: { type: "boolean" | "string"; default?: boolean | string },
		) =>
			flags.set(
				name,
				options.default ?? (options.type === "boolean" ? false : ""),
			),
		getFlag: (name: string) => flags.get(name),
		registerMessageRenderer: () => {},
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				const set = eventHandlers.get(channel) ?? new Set();
				set.add(handler);
				eventHandlers.set(channel, set);
				return () => set.delete(handler);
			},
		},
		sendMessage: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.clear();
			for (const name of names) active.add(name);
		},
	};
	return { pi, tools, handlers, active, emitted, flags, eventHandlers };
}

function fakeContext(sessionId: string, cwd: string) {
	return {
		sessionManager: { getSessionId: () => sessionId },
		cwd,
		ui: { notify: () => {} },
		isProjectTrusted: () => false,
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
	};
}

interface GetResultTool {
	execute(
		id: string,
		params: { agent_id: string; wait?: boolean },
		signal?: AbortSignal,
	): Promise<unknown>;
}

/**
 * Run an aborted `get_subagent_result { wait: true }` and report whether the
 * child stayed running. Non-root aborts terminate the child; a signaled root
 * session rejects the wait without requesting termination.
 */
async function abortWaitLeavesChildRunning(
	tools: Map<string, FakeTool>,
	runId: string,
): Promise<boolean> {
	const getResult = tools.get(
		"get_subagent_result",
	) as unknown as GetResultTool;
	const run = new SubagentRun({
		id: runId,
		subagentType: "explore",
		displayName: "explore",
	});
	getRunRegistry().add(run);
	const controller = new AbortController();
	const pending = getResult.execute(
		`call-${runId}`,
		{ agent_id: runId, wait: true },
		controller.signal,
	);
	controller.abort();
	let running = false;
	if (run.terminationIntent === undefined) {
		try {
			await pending;
		} catch (error) {
			running = /child left running/.test(String(error));
		}
	} else {
		run.transition("aborted", { error: "parent turn aborted" });
		await pending;
	}
	getRunRegistry().delete(runId);
	return running;
}

const cleanups: Array<() => Promise<void>> = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function setupAgentDir(maxDepth: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-ext-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "agents"), { recursive: true });
	await writeFile(join(dir, "pi-subagents.json"), JSON.stringify({ maxDepth }));
	await writeFile(
		join(dir, "agents", "explore.md"),
		"---\ndescription: recon\nmodel: plexus/m\nthinking: off\nlocked: [model, thinking]\n---\nBe careful.\n",
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

describe("extension wiring", () => {
	it("registers the three contract tools as model-only", async () => {
		await setupAgentDir(1);
		const { pi, tools } = createFakePi();
		piSubagents(pi as never);
		expect([...tools.keys()].sort()).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
		]);
		for (const tool of tools.values()) expect(tool.exposure).toBe("model-only");
	});

	it("keeps the spawner at root and hides it at the ceiling", async () => {
		const dir = await setupAgentDir(1);
		const { pi, handlers, active } = createFakePi();
		piSubagents(pi as never);

		const rootId = `root-${process.pid}-a`;
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(rootId, dir),
		);
		expect(active.has("Agent")).toBe(true);

		const childId = `child-${process.pid}-a`;
		getLineageRegistry().register({ sessionId: childId, depth: 1, ceiling: 1 });
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(childId, dir),
		);
		expect(active.has("Agent")).toBe(true);
		// `Agent` stays active only as the prepareLoadout hook holder; the gate
		// blocks it and prepareLoadout hides its declaration (see tools.test.ts).

		getLineageRegistry().delete(rootId);
		getLineageRegistry().delete(childId);
	});

	it("reads the Superpi root signal at tool execution", async () => {
		const dir = await setupAgentDir(1);
		const { pi, tools, flags, handlers } = createFakePi();
		piSubagents(pi as never);

		// The companion owns the launch flag; re-registering it here is the
		// duplicate-flag diagnostic this signal replaces.
		expect(flags.has("superpi-companion-root")).toBe(false);

		const rootId = `ext-superpi-root-${process.pid}`;
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(rootId, dir),
		);

		// Default: aborting the wait terminates the child.
		expect(
			await abortWaitLeavesChildRunning(
				tools,
				`ext-superpi-default-${process.pid}`,
			),
		).toBe(false);

		// Root signaled: the same abort leaves the child running.
		pi.events.emit("superpi:root:v1", { version: 1, sessionId: rootId });
		expect(
			await abortWaitLeavesChildRunning(
				tools,
				`ext-superpi-signaled-${process.pid}`,
			),
		).toBe(true);
	});

	it("accepts the root signal before or after session_start", async () => {
		const dir = await setupAgentDir(1);

		for (const timing of ["before", "after"] as const) {
			const { pi, tools, handlers } = createFakePi();
			piSubagents(pi as never);
			const rootId = `ext-superpi-${timing}-${process.pid}`;
			if (timing === "before") {
				pi.events.emit("superpi:root:v1", { version: 1, sessionId: rootId });
			}
			await handlers.get("session_start")?.(
				{ type: "session_start" },
				fakeContext(rootId, dir),
			);
			if (timing === "after") {
				pi.events.emit("superpi:root:v1", { version: 1, sessionId: rootId });
			}
			expect(
				await abortWaitLeavesChildRunning(
					tools,
					`ext-superpi-${timing}-run-${process.pid}`,
				),
			).toBe(true);
		}
	});

	it("scopes Superpi mode to the signaled session and clears it on shutdown", async () => {
		const dir = await setupAgentDir(1);
		const { pi, tools, handlers } = createFakePi();
		piSubagents(pi as never);

		const rootId = `ext-superpi-scope-root-${process.pid}`;
		const otherId = `ext-superpi-scope-other-${process.pid}`;
		pi.events.emit("superpi:root:v1", { version: 1, sessionId: rootId });

		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(rootId, dir),
		);
		expect(
			await abortWaitLeavesChildRunning(
				tools,
				`ext-superpi-scope-root-run-${process.pid}`,
			),
		).toBe(true);

		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(otherId, dir),
		);
		expect(
			await abortWaitLeavesChildRunning(
				tools,
				`ext-superpi-scope-other-run-${process.pid}`,
			),
		).toBe(false);

		await handlers.get("session_shutdown")?.(
			{ type: "session_shutdown" },
			fakeContext(otherId, dir),
		);
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(rootId, dir),
		);
		expect(
			await abortWaitLeavesChildRunning(
				tools,
				`ext-superpi-scope-reload-run-${process.pid}`,
			),
		).toBe(false);
	});

	it("blocks the spawner at the ceiling through the dispatch gate", async () => {
		const dir = await setupAgentDir(1);
		const { pi, handlers } = createFakePi();
		piSubagents(pi as never);

		const rootId = `root-${process.pid}-b`;
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(rootId, dir),
		);

		const childId = `child-${process.pid}-b`;
		getLineageRegistry().register({ sessionId: childId, depth: 1, ceiling: 1 });
		const blocked = handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "Agent" },
			fakeContext(childId, dir),
		);
		expect(blocked).toMatchObject({ block: true });

		const allowed = handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "read" },
			fakeContext(rootId, dir),
		);
		expect(allowed).toBeUndefined();

		getLineageRegistry().delete(rootId);
		getLineageRegistry().delete(childId);
	});

	it("re-applies the policy when tools activate after session_start", async () => {
		const dir = await setupAgentDir(1);
		const { pi, handlers, active } = createFakePi();
		piSubagents(pi as never);

		const childId = `child-late-${process.pid}`;
		getLineageRegistry().register({
			sessionId: childId,
			depth: 1,
			ceiling: 1,
			policy: resolveToolPolicy(["read", "bash", "grep", "find", "ls"], []),
		});
		await handlers.get("session_start")?.(
			{ type: "session_start" },
			fakeContext(childId, dir),
		);
		expect([...active].sort()).toEqual([
			"Agent",
			"bash",
			"find",
			"grep",
			"ls",
			"read",
		]);

		// Simulate MCP/tool_search activating after session_start.
		active.add("codemode");
		active.add("tool_search");
		active.add("mcp__github__create_issue");
		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start" },
			fakeContext(childId, dir),
		);
		expect(active.has("codemode")).toBe(false);
		expect(active.has("tool_search")).toBe(false);
		expect(active.has("mcp__github__create_issue")).toBe(false);
		expect(active.has("read")).toBe(true);

		getLineageRegistry().delete(childId);
	});
});
