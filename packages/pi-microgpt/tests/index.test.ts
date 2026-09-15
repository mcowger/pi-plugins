import { expect, test } from "bun:test";
import {
	FAST_SERVICE_TIER,
	MAX_CONTEXT_WINDOW,
	isResponsesModel,
	isSupportedModel,
	shouldApplyFastMode,
	withFastServiceTier,
} from "../src/index.ts";
import piMicroGpt from "../src/index.ts";
import { installMultiAgentTools, validateSpawnModelOverride } from "../src/multiagents.ts";

function model(overrides: Partial<{ provider: string; api: string; id: string; contextWindow: number }>) {
		return { name: overrides.id ?? "test", baseUrl: "https://example.com", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1000, provider: "openai", api: "openai-responses", id: "gpt-5.5", contextWindow: 272_000, ...overrides } as any;
}

test("targets Responses API GPT 5.5+ slugs regardless of provider", () => {
	for (const provider of ["openai", "openai-codex", "proxy"]) {
		expect(isSupportedModel(model({ provider, api: "openai-responses", id: "gpt-5.5-codex" }))).toBe(true);
		expect(isSupportedModel(model({ provider, api: "openai-codex-responses", id: "gpt-6-future" }))).toBe(true);
	}
	expect(isSupportedModel(model({ api: "openai-completions", id: "gpt-6-future" }))).toBe(false);
	expect(isSupportedModel(model({ api: "openai-responses", id: "gpt-5.4" }))).toBe(false);
		expect(isResponsesModel(model({ provider: "proxy", api: "openai-codex-responses", id: "gpt-5.5" }))).toBe(true);
});

test("Fast mode patches only the matching supported request", () => {
	const target = model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" });
	expect(shouldApplyFastMode(target, { model: target.id })).toBe(true);
	expect(withFastServiceTier({ model: target.id, input: [] })).toEqual({ model: target.id, input: [], service_tier: FAST_SERVICE_TIER });
	expect(shouldApplyFastMode(target, { model: "gpt-5.4" })).toBe(false);
});

test("Codex tools use the same shared model restriction", () => {
	expect(isSupportedModel(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" }))).toBe(true);
	expect(isSupportedModel(model({ provider: "proxy", api: "openai-codex-responses", id: "gpt-6" }))).toBe(true);
	expect(isSupportedModel(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.4-codex" }))).toBe(false);
});

test("multi-agent child overrides must satisfy the shared model restriction", () => {
	const inherited = model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" });
	const findModel = (provider: string, id: string) => model({ provider, id, api: "openai-responses" });
	expect(() => validateSpawnModelOverride(undefined, inherited, findModel, isSupportedModel)).not.toThrow();
	expect(() => validateSpawnModelOverride("gpt-6", inherited, findModel, isSupportedModel)).not.toThrow();
	expect(() => validateSpawnModelOverride("anthropic/claude-sonnet", inherited, findModel, isSupportedModel)).toThrow(/must be a supported GPT/);
	expect(() => validateSpawnModelOverride(undefined, model({ api: "anthropic-messages", id: "claude" }), findModel, isSupportedModel)).toThrow(/require a supported GPT/);
});

test("multi-agent tools are active only for supported models", async () => {
	const pi = mockPi();
	installMultiAgentTools(pi as any, isSupportedModel);
	expect(pi.tools.has("spawn_agent")).toBe(true);
	pi.activateRuntime();
	expect(pi.getActiveTools()).not.toContain("spawn_agent");
	const start = pi.handlers.get("session_start");
	const select = pi.handlers.get("model_select");
	const supported = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" }));
	Object.assign(supported, { cwd: "/tmp/project", isProjectTrusted: () => true });
	start({}, supported);
	expect(pi.getActiveTools()).toContain("spawn_agent");
	select({ model: model({ provider: "proxy", api: "openai-responses", id: "gpt-5.4" }) }, supported);
	expect(pi.getActiveTools()).not.toContain("spawn_agent");
	select({ model: model({ provider: "proxy", api: "openai-responses", id: "gpt-6" }) }, supported);
	expect(pi.getActiveTools()).toContain("spawn_agent");
	const unsupported = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.4" }));
	await expect(pi.tools.get("spawn_agent").execute("call-1", { task_name: "worker", message: "test" }, undefined, undefined, unsupported as any)).rejects.toThrow(/require a supported GPT/);
	await pi.handlers.get("session_shutdown")({}, supported);
});

function mockPi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	let activeTools = ["edit", "write"];
	let runtimeReady = false;
	return {
		commands,
		handlers,
		tools,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerShortcut() {},
		activateRuntime() { runtimeReady = true; },
		getActiveTools() {
			if (!runtimeReady) throw new Error("Extension runtime not initialized");
			return activeTools;
		},
		setActiveTools(tools: string[]) {
			if (!runtimeReady) throw new Error("Extension runtime not initialized");
			activeTools = tools;
		},
		on(name: string, handler: any) { handlers.set(name, handler); },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
}

function context(model: any) {
	const notifications: string[] = [];
	return {
		model,
		notifications,
		mode: "rpc",
		hasUI: false,
		ui: { notify(message: string) { notifications.push(message); } },
	};
}

test("commands emit machine-readable JSON and support JSON requests", async () => {
	const pi = mockPi();
	piMicroGpt(pi as any);
	const ctx = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" }));
	await pi.commands.get("long-context").handler("status", ctx);
	await pi.commands.get("fast").handler('{"action":"on","requestId":"fast-1"}', ctx);
	await pi.commands.get("long-context").handler('{"action":"on","requestId":"long-1"}', ctx);
	for (const message of ctx.notifications) {
		const parsed = JSON.parse(message);
		expect(parsed.type).toBe("pi-microgpt.response");
		expect(parsed.success).toBe(true);
	}
	expect(JSON.parse(ctx.notifications[0]).enabled).toBe(false);
	expect(JSON.parse(ctx.notifications[1]).requestId).toBe("fast-1");
	expect(JSON.parse(ctx.notifications[2]).contextWindow).toBe(MAX_CONTEXT_WINDOW);
});

test("web search is off by default and can be enabled for the session", async () => {
	const pi = mockPi();
	piMicroGpt(pi as any);
	pi.activateRuntime();
	const ctx = context(model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" }));
	await pi.commands.get("web-search").handler("status", ctx);
	expect(JSON.parse(ctx.notifications[0]).enabled).toBe(false);
	await pi.commands.get("web-search").handler("on", ctx);
	expect(JSON.parse(ctx.notifications[1]).enabled).toBe(true);
});
