import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piSubagents from "../index.js";
import { getLineageRegistry } from "../src/lineage.js";

interface FakeTool {
	name: string;
	exposure?: string;
}

function createFakePi() {
	const tools = new Map<string, FakeTool>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const active = new Set<string>([
		"read",
		"bash",
		"Agent",
		"get_subagent_result",
		"steer_subagent",
	]);
	const emitted: Array<{ channel: string; data: unknown }> = [];

	const pi = {
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		events: {
			emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
			on: () => () => {},
		},
		sendMessage: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.clear();
			for (const name of names) active.add(name);
		},
	};
	return { pi, tools, handlers, active, emitted };
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
		expect(active.has("Agent")).toBe(false);

		getLineageRegistry().delete(rootId);
		getLineageRegistry().delete(childId);
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
});
