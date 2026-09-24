import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import superAgents, { __setRunChildForTests } from "../src/index.ts";
import type { RunChildOptions, RunChildResult } from "../src/runner.ts";
import type { RunUsage } from "../src/types.ts";

const ENV_KEY = "PI_CODING_AGENT_DIR";

interface SchemaNode {
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	enum?: string[];
}

interface FakeToolResult {
	content: Array<{ type: string; text: string }>;
	details: { runs: Array<{ id: string; status: string }> };
}

interface FakeTool {
	name: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<FakeToolResult>;
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function zeroUsage(): RunUsage {
	return { turns: 1, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

function mockPi() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	return {
		handlers,
		tools,
		appended,
		sent,
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerTool(tool: FakeTool) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		cwd: "/tmp/does-not-exist-super-agents-pi",
		hasUI: true,
		ui: {
			notify(message: string, type: string = "info") {
				notifications.push({ message, type });
			},
		},
		notifications,
		sessionManager: { getSessionId: () => "parent-session-1" },
		model: { provider: "anthropic", id: "claude-x" },
		modelRegistry: {},
		thinkingLevel: undefined,
		isIdle: () => true,
		signal: undefined,
		...overrides,
	};
}

async function writeAgentFile(
	agentsDir: string,
	slug: string,
	opts: { description?: string; allowModelOverride?: boolean } = {},
): Promise<void> {
	await mkdir(agentsDir, { recursive: true });
	const frontmatter = [
		"---",
		`description: ${opts.description ?? `Agent ${slug}`}`,
		...(opts.allowModelOverride ? ["allow_model_override: true"] : []),
		"---",
		`You are ${slug}.`,
	].join("\n");
	await writeFile(join(agentsDir, `${slug}.md`), frontmatter, "utf-8");
}

/** Resolves immediately with a completed result. */
async function immediateRunChild(opts: RunChildOptions): Promise<RunChildResult> {
	opts.onStarted({ model: "anthropic/claude-x", thinking: undefined, overrideIgnored: false });
	await Promise.resolve();
	return { status: "completed", text: `result for ${opts.task.name ?? opts.agent.slug}`, usage: zeroUsage() };
}

/** Never resolves until `resolveNext` is called; used to prove background execute returns without waiting. */
function makeControllableRunChild() {
	const pending: Array<(r: RunChildResult) => void> = [];
	const runChild = async (opts: RunChildOptions): Promise<RunChildResult> => {
		opts.onStarted({ model: "anthropic/claude-x", thinking: undefined, overrideIgnored: false });
		return new Promise<RunChildResult>((resolve) => {
			pending.push(resolve);
			opts.signal.addEventListener("abort", () => resolve({ status: "aborted", text: "", usage: zeroUsage() }), {
				once: true,
			});
		});
	};
	return {
		runChild,
		resolveNext(result: Partial<RunChildResult> = {}) {
			const resolve = pending.shift();
			if (!resolve) throw new Error("no pending runChild call to resolve");
			resolve({ status: "completed", text: "ok", usage: zeroUsage(), ...result });
		},
	};
}

let previousEnv: string | undefined;
let agentDirTemp: string;
let agentsSubdir: string;

beforeEach(async () => {
	previousEnv = process.env[ENV_KEY];
	agentDirTemp = await mkdtemp(join(tmpdir(), "super-agents-pi-agentdir-"));
	agentsSubdir = join(agentDirTemp, "agents");
	process.env[ENV_KEY] = agentDirTemp;
});

afterEach(async () => {
	if (previousEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = previousEnv;
	await rm(agentDirTemp, { recursive: true, force: true });
});

describe("session_start", () => {
	it("registers all four tools", async () => {
		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		expect([...pi.tools.keys()].sort()).toEqual(["agent", "agent_status", "agent_stop", "agent_wait"]);
	});

	it("builds the agent enum from files on disk", async () => {
		await writeAgentFile(agentsSubdir, "scout");
		await writeAgentFile(agentsSubdir, "writer");

		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// biome-ignore lint/style/noNonNullAssertion: registered by session_start above
		const agentTool = pi.tools.get("agent")!;
		const schema = agentTool.parameters as unknown as SchemaNode;
		// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
		const agentSchema = schema.properties!.tasks.items!.properties!.agent;
		expect(agentSchema.enum).toEqual(["scout", "writer"]);
	});

	it("updates the enum when session_start is re-run after adding a file", async () => {
		await writeAgentFile(agentsSubdir, "scout");

		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		function enumSlugs(): string[] | undefined {
			// biome-ignore lint/style/noNonNullAssertion: registered by session_start above
			const schema = pi.tools.get("agent")!.parameters as unknown as SchemaNode;
			// biome-ignore lint/style/noNonNullAssertion: shape is asserted by the test itself
			return schema.properties!.tasks.items!.properties!.agent.enum;
		}

		expect(enumSlugs()).toEqual(["scout"]);

		await writeAgentFile(agentsSubdir, "writer");
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);

		expect(enumSlugs()).toEqual(["scout", "writer"]);
	});
});

describe("session_shutdown", () => {
	it("tears the manager down so subsequent tool calls fail", async () => {
		await writeAgentFile(agentsSubdir, "scout");
		__setRunChildForTests(makeControllableRunChild().runChild);

		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

		// biome-ignore lint/style/noNonNullAssertion: registered by session_start above
		const statusTool = pi.tools.get("agent_status")!;
		await expect(statusTool.execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow(
			"super-agents-pi is not initialised",
		);
	});
});

describe("agent tool execute", () => {
	it("background: true returns ids immediately without waiting for completion", async () => {
		await writeAgentFile(agentsSubdir, "scout");
		const controllable = makeControllableRunChild();
		__setRunChildForTests(controllable.runChild);

		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// biome-ignore lint/style/noNonNullAssertion: registered by session_start above
		const agentTool = pi.tools.get("agent")!;
		const result = await agentTool.execute(
			"call-1",
			{ tasks: [{ agent: "scout", prompt: "do the thing" }], background: true },
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);

		expect(result.content[0]?.text).toContain("Started in background:");
		expect(result.details.runs).toHaveLength(1);
		expect(result.details.runs[0]?.id).toMatch(/^[a-z0-9]{8}$/);

		controllable.resolveNext();
	});

	it("foreground execute awaits completion and returns formatted results", async () => {
		await writeAgentFile(agentsSubdir, "scout");
		__setRunChildForTests(immediateRunChild);

		const pi = mockPi();
		superAgents(pi as unknown as ExtensionAPI);
		const ctx = makeCtx({ cwd: agentDirTemp });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// biome-ignore lint/style/noNonNullAssertion: registered by session_start above
		const agentTool = pi.tools.get("agent")!;
		const result = await agentTool.execute(
			"call-1",
			{ tasks: [{ agent: "scout", prompt: "do the thing", name: "run-a" }] },
			undefined,
			undefined,
			ctx as unknown as ExtensionContext,
		);

		expect(result.content[0]?.text).toContain("run-a (scout)");
		expect(result.content[0]?.text).toContain("result for run-a");
		expect(result.details.runs[0]?.status).toBe("completed");
	});
});
