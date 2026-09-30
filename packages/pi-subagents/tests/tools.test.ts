import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		emitChildCreated: () => {},
		emitChildDisposed: () => {},
		emitEvent: () => {},
	};
}

function requiredOf(tool: { parameters: unknown }): string[] {
	return (tool.parameters as { required?: string[] }).required ?? [];
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
		expect(buildGetResultTool().exposure).toBe("model-only");
		expect(buildSteerTool(noopDeps()).exposure).toBe("model-only");
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
	it("claims the result while blocking so no notification fires", async () => {
		const run = new SubagentRun({
			id: "wait-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const pending = buildGetResultTool().execute("7", {
			agent_id: "wait-test",
			wait: true,
		});
		expect(run.resultRequested).toBe(true);
		run.transition("completed", { summary: "pong" });
		await pending;
		expect(run.resultRequested).toBe(true);
	});

	it("claims a terminal result on a non-blocking read", async () => {
		const run = new SubagentRun({
			id: "poll-test",
			subagentType: "explore",
			displayName: "explore",
		});
		run.transition("completed", { summary: "pong" });
		getRunRegistry().add(run);
		await buildGetResultTool().execute("8", { agent_id: "poll-test" });
		expect(run.resultRequested).toBe(true);
	});

	it("cancels the child when the waiting tool call is aborted", async () => {
		const run = new SubagentRun({
			id: "abort-test",
			subagentType: "explore",
			displayName: "explore",
		});
		getRunRegistry().add(run);
		const controller = new AbortController();
		const pending = buildGetResultTool().execute(
			"9",
			{ agent_id: "abort-test", wait: true },
			controller.signal,
		);
		controller.abort();
		expect(run.terminationIntent).toBe("aborted");
		run.transition("aborted", { error: "parent turn aborted" });
		await pending;
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
			displayName: "worker",
		});
		terminal.transition("completed");
		getRunRegistry().add(terminal);
		const result = await tool.execute("6", {
			agent_id: "done-test",
			message: "hi",
		});
		const text = (result.content as Array<{ type: string; text?: string }>)
			.map((block) => block.text ?? "")
			.join("\n");
		expect(text).toContain("is not running (status: completed)");
	});
});
