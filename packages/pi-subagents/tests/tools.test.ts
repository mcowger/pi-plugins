import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { getRunRegistry, SubagentRun } from "../src/run.js";
import { resolveToolPolicy } from "../src/selectors.js";
import {
	buildAgentCatalog,
	buildAgentTool,
	buildGetResultTool,
	buildSteerTool,
} from "../src/tools.js";

function noopDeps() {
	return {
		sendMessage: () => {},
		loadConfig: () => ({
			maxDepth: 1,
			approvedExtensions: {},
			excludedExtensions: [],
		}),
		getSessionState: () => undefined,
		isSuperpiRoot: () => false,
		emitChildCreated: () => {},
		emitChildDisposed: () => {},
		emitEvent: () => {},
		emitBridge: () => {},
	};
}

function superpiDeps() {
	return { ...noopDeps(), isSuperpiRoot: () => true };
}

function requiredOf(tool: { parameters: unknown }): string[] {
	return (tool.parameters as { required?: string[] }).required ?? [];
}

function textOf(result: unknown): string {
	return (result as { content: Array<{ type: string; text?: string }> }).content
		.map((block) => block.text ?? "")
		.join("\n");
}

function detailsOf(result: unknown): Record<string, unknown> {
	return ((result as { details?: Record<string, unknown> }).details ??
		{}) as Record<string, unknown>;
}

interface CapturedUpdate {
	text: string;
	details: Record<string, unknown>;
}

function captureUpdates(): {
	updates: CapturedUpdate[];
	onUpdate: AgentToolUpdateCallback;
} {
	const updates: CapturedUpdate[] = [];
	const onUpdate: AgentToolUpdateCallback = (update) => {
		updates.push({ text: textOf(update), details: detailsOf(update) });
	};
	return { updates, onUpdate };
}

describe("tool schemas", () => {
	it("requires subagent_type, prompt, and description", () => {
		const schema = buildAgentTool(noopDeps()).parameters as unknown as {
			additionalProperties?: boolean;
		};
		expect(schema.additionalProperties).toBe(false);
		expect(requiredOf(buildAgentTool(noopDeps()))).toEqual([
			"subagent_type",
			"prompt",
			"description",
		]);
	});

	it("requires message on steer_subagent and has no cancel", () => {
		expect(requiredOf(buildSteerTool(noopDeps()))).toEqual([
			"agent_id",
			"message",
		]);
		const props = (
			buildSteerTool(noopDeps()).parameters as unknown as {
				properties: Record<string, unknown>;
			}
		).properties;
		expect(Object.keys(props).sort()).toEqual(["agent_id", "message"]);
	});

	it("declares the model-only orchestration exposure", () => {
		expect(buildAgentTool(noopDeps()).exposure).toBe("model-only");
		expect(buildGetResultTool(noopDeps()).exposure).toBe("model-only");
		expect(buildSteerTool(noopDeps()).exposure).toBe("model-only");
	});

	it("requires retrieving every spawned result before finishing", () => {
		expect(buildAgentTool(noopDeps()).description).toContain(
			"MUST call get_subagent_result with wait: true for every Agent id",
		);
		expect(buildGetResultTool(noopDeps()).description).toContain(
			"MUST call this with wait: true for every id returned by Agent",
		);
	});

	it("hides non-policy tools through prepareLoadout", () => {
		const deps = {
			...noopDeps(),
			getSessionState: () => ({
				cwd: "/tmp",
				agentDir: "/tmp/agent",
				config: {
					maxDepth: 1,
					approvedExtensions: {},
					excludedExtensions: [],
				},
				lineage: {
					sessionId: "s",
					depth: 0,
					ceiling: 1,
					policy: resolveToolPolicy(["read"], []),
				},
				trusted: false,
			}),
		};
		const changes = buildAgentTool(deps).prepareLoadout?.({
			declared: [{ name: "read" }, { name: "write" }],
		} as never);
		expect(changes?.hiddenDeclarations).toEqual(["write"]);
	});

	it("hides the spawner as well as disallowed tools at the ceiling", () => {
		const deps = {
			...noopDeps(),
			getSessionState: () => ({
				cwd: "/tmp",
				agentDir: "/tmp/agent",
				config: { maxDepth: 1, approvedExtensions: {}, excludedExtensions: [] },
				lineage: {
					sessionId: "s",
					depth: 1,
					ceiling: 1,
					policy: resolveToolPolicy(["read"], []),
				},
				trusted: false,
			}),
		};
		const changes = buildAgentTool(deps).prepareLoadout?.({
			declared: [{ name: "read" }, { name: "codemode" }, { name: "Agent" }],
		} as never);
		expect(changes?.hiddenDeclarations).toEqual(
			expect.arrayContaining(["Agent", "codemode"]),
		);
		expect(changes?.hiddenDeclarations).not.toContain("read");
	});

	it("lists agent names and descriptions in the Agent description", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-catalog-"));
		const agents = join(dir, "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			join(agents, "explore.md"),
			"---\ndescription: Read-only recon\n---\nBody\n",
		);
		writeFileSync(
			join(agents, "worker.md"),
			"---\ndescription: Implements plans\n---\nBody\n",
		);
		const deps = {
			...noopDeps(),
			getSessionState: () => ({
				cwd: dir,
				agentDir: dir,
				config: { maxDepth: 1, approvedExtensions: {}, excludedExtensions: [] },
				lineage: { sessionId: "s", depth: 0, ceiling: 1 },
				trusted: false,
			}),
		};
		const changes = buildAgentTool(deps).prepareLoadout?.({
			declared: [{ name: "Agent" }],
		} as never);
		expect(changes?.descriptions?.Agent).toContain(
			"- explore: Read-only recon",
		);
		expect(changes?.descriptions?.Agent).toContain(
			"- worker: Implements plans",
		);
		expect(changes?.descriptions?.Agent).toContain("subagent_type");
	});

	it("omits disabled agents from the catalog", () => {
		expect(
			buildAgentCatalog(
				new Map([
					[
						"off",
						{
							name: "off",
							description: "disabled",
							enabled: false,
						} as never,
					],
				]),
			),
		).toBe("");
	});
});

describe("get_subagent_result", () => {
	it("waits for and returns the child result", async () => {
		const run = new SubagentRun({
			id: "wait-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const pending = buildGetResultTool(noopDeps()).execute("7", {
			agent_id: "wait-test",
			wait: true,
		});
		run.transition("completed", { summary: "pong" });
		const result = await pending;
		expect(textOf(result)).toContain("pong");
	});

	it("emits the wait identity header before blocking on settled", async () => {
		const run = new SubagentRun({
			id: "wait-update",
			subagentType: "explore",
			displayName: "explore-display",
			description: "wait description",
		});
		getRunRegistry().add(run);
		const { updates, onUpdate } = captureUpdates();
		const pending = buildGetResultTool(noopDeps()).execute(
			"7a",
			{ agent_id: "wait-update", wait: true },
			undefined,
			onUpdate,
		);
		// The identity update must land before the run settles.
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0].text).toContain(
			"Agent: wait-update\nOperation: wait\nType: explore | Status: running\nDescription: wait description",
		);
		expect(updates[0].details).toMatchObject({
			agentId: "wait-update",
			operation: "wait",
			subagentType: "explore",
			description: "wait description",
			status: "running",
		});
		run.transition("completed", { summary: "pong" });
		const result = await pending;
		expect(textOf(result)).toContain("pong");
		expect(detailsOf(result)).toMatchObject({
			agentId: "wait-update",
			operation: "wait",
			subagentType: "explore",
			description: "wait description",
			status: "completed",
		});
	});

	it("returns a terminal result on a non-blocking read", async () => {
		const run = new SubagentRun({
			id: "poll-test",
			subagentType: "explore",
			displayName: "explore",
		});
		run.transition("completed", { summary: "pong" });
		getRunRegistry().add(run);
		const result = await buildGetResultTool(noopDeps()).execute("8", {
			agent_id: "poll-test",
		});
		expect(textOf(result)).toContain("pong");
	});

	it("labels a non-blocking read as the result operation", async () => {
		const run = new SubagentRun({
			id: "poll-details",
			subagentType: "worker",
			displayName: "worker-display",
			description: "poll description",
		});
		run.transition("completed", { summary: "pong" });
		getRunRegistry().add(run);
		const result = await buildGetResultTool(noopDeps()).execute("8a", {
			agent_id: "poll-details",
		});
		expect(textOf(result)).toContain(
			"Agent: poll-details\nOperation: result\nType: worker | Status: completed\nDescription: poll description",
		);
		expect(detailsOf(result)).toMatchObject({
			agentId: "poll-details",
			operation: "result",
			subagentType: "worker",
			description: "poll description",
			status: "completed",
		});
	});

	it("cancels the child when the waiting tool call is aborted", async () => {
		const run = new SubagentRun({
			id: "abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		const pending = buildGetResultTool(noopDeps()).execute(
			"9",
			{ agent_id: "abort-test", wait: true },
			controller.signal,
		);
		controller.abort();
		expect(run.terminationIntent).toBe("aborted");
		run.transition("aborted", { error: "parent turn aborted" });
		await pending;
	});

	it("cancels immediately when the waiting signal is already aborted", async () => {
		const run = new SubagentRun({
			id: "pre-abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		controller.abort();
		const pending = buildGetResultTool(noopDeps()).execute(
			"9a",
			{ agent_id: "pre-abort-test", wait: true },
			controller.signal,
		);
		expect(run.terminationIntent).toBe("aborted");
		run.transition("aborted", { error: "parent turn aborted" });
		await pending;
	});

	it("removes its abort listener once the wait settles normally", async () => {
		const run = new SubagentRun({
			id: "listener-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		const pending = buildGetResultTool(noopDeps()).execute(
			"9b",
			{ agent_id: "listener-test", wait: true },
			controller.signal,
		);
		run.transition("completed", { summary: "pong" });
		await pending;
		controller.abort();
		expect(run.terminationIntent).toBeUndefined();
	});

	it("does not cancel the child for an aborted polling read", async () => {
		const run = new SubagentRun({
			id: "poll-abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		const result = await buildGetResultTool(noopDeps()).execute(
			"9c",
			{ agent_id: "poll-abort-test" },
			controller.signal,
		);
		controller.abort();
		expect(run.terminationIntent).toBeUndefined();
		expect(textOf(result)).toContain("still running");
	});

	it("leaves the child running when a Superpi root wait is aborted", async () => {
		const run = new SubagentRun({
			id: "superpi-abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		const pending = buildGetResultTool(superpiDeps()).execute(
			"10",
			{ agent_id: "superpi-abort-test", wait: true },
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toThrow("child left running");
		// R6.4: the owned child is not terminated, and abort never reaches it.
		expect(run.terminationIntent).toBeUndefined();
		expect(run.terminal).toBe(false);
		expect(run.status).toBe("running");
		// It still settles later and a follow-up read returns the result.
		run.transition("completed", { summary: "pong" });
		const result = await buildGetResultTool(superpiDeps()).execute("10b", {
			agent_id: "superpi-abort-test",
		});
		expect(textOf(result)).toContain("pong");
	});

	it("stops immediately for an already-aborted Superpi root wait", async () => {
		const run = new SubagentRun({
			id: "superpi-pre-abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		controller.abort();
		const pending = buildGetResultTool(superpiDeps()).execute(
			"10c",
			{ agent_id: "superpi-pre-abort-test", wait: true },
			controller.signal,
		);
		await expect(pending).rejects.toThrow("child left running");
		expect(run.terminationIntent).toBeUndefined();
		expect(run.terminal).toBe(false);
	});

	it("still returns a normal Superpi root wait result when not aborted", async () => {
		const run = new SubagentRun({
			id: "superpi-wait-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const pending = buildGetResultTool(superpiDeps()).execute("10d", {
			agent_id: "superpi-wait-test",
			wait: true,
		});
		run.transition("completed", { summary: "pong" });
		const result = await pending;
		expect(textOf(result)).toContain("pong");
	});

	it("reads the Superpi root predicate at execution time", async () => {
		const run = new SubagentRun({
			id: "superpi-dynamic-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		let superpiRoot = false;
		const deps = { ...noopDeps(), isSuperpiRoot: () => superpiRoot };
		const controller = new AbortController();
		const pending = buildGetResultTool(deps).execute(
			"10e",
			{ agent_id: "superpi-dynamic-test", wait: true },
			controller.signal,
		);
		// Default mode terminates the now-aborted child.
		controller.abort();
		expect(run.terminationIntent).toBe("aborted");
		run.transition("aborted", { error: "parent turn aborted" });
		await pending;
		expect(run.terminal).toBe(true);

		// A second call, now in Superpi mode, must not cache the factory value.
		const superpiRun = new SubagentRun({
			id: "superpi-dynamic-later",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(superpiRun);
		superpiRoot = true;
		const superpiController = new AbortController();
		const superpiPending = buildGetResultTool(deps).execute(
			"10f",
			{ agent_id: "superpi-dynamic-later", wait: true },
			superpiController.signal,
		);
		await superpiController.abort();
		await expect(superpiPending).rejects.toThrow("child left running");
		expect(superpiRun.terminationIntent).toBeUndefined();
	});
});

describe("steer_subagent", () => {
	const run = new SubagentRun({
		id: "steer-test",
		subagentType: "explore",
		displayName: "explore",
	});
	const calls: string[] = [];
	run.attachChild(
		{
			isStreaming: true,
			steer: async (text: string) => {
				calls.push(`steer:${text}`);
			},
			prompt: async (text: string) => {
				calls.push(`prompt:${text}`);
			},
		},
		() => {},
	);
	getRunRegistry().add(run);

	const tool = buildSteerTool(noopDeps());

	it("returns a not-found result for unknown ids", async () => {
		const result = await tool.execute("4", {
			agent_id: "missing",
			message: "hi",
		});
		const text = (result.content as Array<{ type: string; text?: string }>)
			.map((block) => block.text ?? "")
			.join("\n");
		expect(text).toContain('Agent not found: "missing"');
	});

	it("steers a streaming child", async () => {
		await tool.execute("5", { agent_id: "steer-test", message: "focus" });
		expect(calls).toContain("steer:focus");
	});

	it("refuses a terminal run and reports its status", async () => {
		const terminal = new SubagentRun({
			id: "done-test",
			subagentType: "worker",
			displayName: "worker-display",
			description: "terminal description",
		});
		terminal.transition("completed");
		getRunRegistry().add(terminal);
		const result = await tool.execute("6", {
			agent_id: "done-test",
			message: "hi",
		});
		expect(textOf(result)).toContain("is not running (status: completed)");
		expect(detailsOf(result)).toMatchObject({
			agentId: "done-test",
			operation: "steer",
			subagentType: "worker",
			description: "terminal description",
			status: "completed",
		});
	});

	it("emits the steer identity before steering a streaming child", async () => {
		const streamed: string[] = [];
		const srun = new SubagentRun({
			id: "steer-update",
			subagentType: "explore",
			displayName: "explore-display",
			description: "steer description",
		});
		srun.attachChild(
			{
				isStreaming: true,
				steer: async (text: string) => {
					streamed.push(text);
				},
				prompt: async () => {},
			},
			() => {},
		);
		getRunRegistry().add(srun);
		const { updates, onUpdate } = captureUpdates();
		const pending = tool.execute(
			"6a",
			{ agent_id: "steer-update", message: "focus" },
			undefined,
			onUpdate,
		);
		// The identity update must land before the steer is awaited.
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0].text).toContain(
			"Agent: steer-update\nOperation: steer\nType: explore | Status: running\nDescription: steer description",
		);
		expect(updates[0].details).toMatchObject({
			agentId: "steer-update",
			operation: "steer",
			subagentType: "explore",
			description: "steer description",
			status: "running",
		});
		const result = await pending;
		expect(streamed).toEqual(["focus"]);
		expect(detailsOf(result)).toMatchObject({
			agentId: "steer-update",
			operation: "steer",
			subagentType: "explore",
			description: "steer description",
			status: "running",
		});
	});

	it("emits the steer identity before prompting a non-streaming child", async () => {
		const prompted: string[] = [];
		const srun = new SubagentRun({
			id: "steer-prompt",
			subagentType: "explore",
			displayName: "explore-display",
			description: "prompt description",
		});
		srun.attachChild(
			{
				isStreaming: false,
				steer: async () => {},
				prompt: async (text: string) => {
					prompted.push(text);
				},
			},
			() => {},
		);
		getRunRegistry().add(srun);
		const { updates, onUpdate } = captureUpdates();
		await tool.execute(
			"6b",
			{ agent_id: "steer-prompt", message: "nudge" },
			undefined,
			onUpdate,
		);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0].text).toContain("Operation: steer");
		expect(updates[0].details).toMatchObject({
			agentId: "steer-prompt",
			operation: "steer",
		});
		expect(prompted).toEqual(["nudge"]);
	});
});
