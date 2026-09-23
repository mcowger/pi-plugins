import { expect, test } from "bun:test";
import {
	FAST_SERVICE_TIER,
	FLEX_SERVICE_TIER,
	MAX_CONTEXT_WINDOW,
	isFlexSupportedModel,
	isResponsesModel,
	isSupportedModel,
	resolveServiceTier,
	shouldApplyFastMode,
	shouldApplyFlexMode,
	shouldApplyServiceTier,
	withFastServiceTier,
	withFlexServiceTier,
	withServiceTier,
} from "../src/index.ts";
import piMicroGpt from "../src/index.ts";

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
		cwd: "/tmp/project",
		isProjectTrusted: () => true,
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
	await pi.commands.get("long-context").handler('{"action":"on","requestId":"long-2"}', ctx);
	await pi.commands.get("long-context").handler('{"action":"off","requestId":"long-3"}', ctx);
	for (const message of ctx.notifications) {
		const parsed = JSON.parse(message);
		expect(parsed.type).toBe("pi-microgpt.response");
		expect(typeof parsed.success).toBe("boolean");
	}
	expect(JSON.parse(ctx.notifications[0]).enabled).toBe(false);
	expect(JSON.parse(ctx.notifications[1]).requestId).toBe("fast-1");
	expect(JSON.parse(ctx.notifications[2]).contextWindow).toBe(MAX_CONTEXT_WINDOW);
	expect(JSON.parse(ctx.notifications[3])).toMatchObject({ success: true, enabled: true, requestId: "long-2" });
	expect(JSON.parse(ctx.notifications[4])).toMatchObject({ success: true, enabled: false, requestId: "long-3" });
});

test("status aliases return JSON errors for malformed JSON requests", async () => {
	const pi = mockPi();
	piMicroGpt(pi as any);
	const ctx = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" }));
	for (const name of ["long-context-status", "fast-status", "flex-status", "web-search-status"]) {
		await pi.commands.get(name).handler('{"action":"on","requestId":"invalid-1"}', ctx);
		const wrongAction = JSON.parse(ctx.notifications.at(-1)!);
		expect(wrongAction).toMatchObject({ type: "pi-microgpt.response", success: false, requestId: "invalid-1" });
		expect(wrongAction.error).toBeDefined();
		await pi.commands.get(name).handler('{"action":', ctx);
		const malformed = JSON.parse(ctx.notifications.at(-1)!);
		expect(malformed).toMatchObject({ type: "pi-microgpt.response", success: false });
		expect(malformed.error).toBeDefined();
	}
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


test("flex support follows OpenAI's flex SKU within plugin scope", () => {
	const flexModels = [
		"gpt-6-astra",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.6-sol-2026-01-01",
		"gpt-5.6-luna-codex",
		"GPT-5.6-TERRA",
	];
	for (const id of flexModels) {
		expect(isFlexSupportedModel(model({ provider: "proxy", api: "openai-responses", id }))).toBe(true);
	}
	const notFlex = [
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.2",
		"gpt-5.1",
		"gpt-5.6-cyber",
		"gpt-4.1",
		"gpt-4o",
		"o1",
		"o3-mini",
	];
	for (const id of notFlex) {
		expect(isFlexSupportedModel(model({ provider: "proxy", api: "openai-responses", id }))).toBe(false);
	}
	// o3, o4-mini, and the gpt-5 family support flex per OpenAI, but sit
	// outside this plugin's GPT-5.5+ scope.
	for (const id of ["o3", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano"]) {
		expect(isFlexSupportedModel(model({ provider: "proxy", api: "openai-responses", id }))).toBe(false);
	}
	expect(isFlexSupportedModel(model({ provider: "proxy", api: "openai-completions", id: "gpt-5.6-sol" }))).toBe(false);
});

test("flex mode patches with the flex tier and stays exclusive with fast mode", async () => {
	expect(FLEX_SERVICE_TIER).toBe("flex");
	expect(resolveServiceTier(false, false)).toBe("off");
	expect(resolveServiceTier(true, false)).toBe(FAST_SERVICE_TIER);
	expect(resolveServiceTier(false, true)).toBe(FLEX_SERVICE_TIER);
	expect(resolveServiceTier(true, true)).toBe(FAST_SERVICE_TIER);
	expect(withServiceTier({ model: "gpt-5.6-sol" }, FLEX_SERVICE_TIER)).toEqual({ model: "gpt-5.6-sol", service_tier: "flex" });
	expect(withFlexServiceTier({ model: "gpt-5.6-sol" })).toEqual({ model: "gpt-5.6-sol", service_tier: "flex" });

	const target = model({ provider: "proxy", api: "openai-responses", id: "gpt-5.6-sol" });
	expect(shouldApplyServiceTier(target, { model: target.id })).toBe(true);
	expect(shouldApplyFlexMode(target, { model: target.id })).toBe(true);
	expect(shouldApplyFlexMode(target, { model: "other" })).toBe(false);
	const withoutFlex = model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" });
	expect(shouldApplyFlexMode(withoutFlex, { model: withoutFlex.id })).toBe(false);
	expect(shouldApplyFastMode(withoutFlex, { model: withoutFlex.id })).toBe(true);

	const pi = mockPi();
	piMicroGpt(pi as any);
	pi.activateRuntime();
	const ctx = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.6-sol" }));
	await pi.commands.get("flex").handler("status", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: false, serviceTier: "off", supported: true });
	await pi.commands.get("flex").handler('{"action":"on","requestId":"flex-1"}', ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: true, serviceTier: "flex", supported: true, requestId: "flex-1" });
	await pi.commands.get("fast").handler("status", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "fast", enabled: false, serviceTier: "flex" });
	await pi.commands.get("fast").handler("on", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "fast", enabled: true, serviceTier: "priority" });
	await pi.commands.get("flex").handler("status", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: false, serviceTier: "priority" });
	await pi.commands.get("fast").handler("off", ctx);
	await pi.commands.get("flex").handler("on", ctx);
	await pi.commands.get("flex-status").handler("", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: true, serviceTier: "flex", supported: true });
	await pi.handlers.get("session_start")({}, ctx);
	await pi.commands.get("flex").handler("status", ctx);
	expect(JSON.parse(ctx.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: false, serviceTier: "off" });

	const legacy = context(model({ provider: "proxy", api: "openai-responses", id: "gpt-5.5" }));
	await pi.commands.get("flex").handler("status", legacy);
	expect(JSON.parse(legacy.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: false, supported: false });
	await pi.commands.get("flex").handler("on", legacy);
	expect(JSON.parse(legacy.notifications.at(-1)!)).toMatchObject({ command: "flex", enabled: true, supported: false });
	await pi.commands.get("fast").handler("status", legacy);
	expect(JSON.parse(legacy.notifications.at(-1)!)).toMatchObject({ command: "fast", supported: true });
});

test("registers the pinned upstream apply_patch tool", () => {
	const pi = mockPi();
	piMicroGpt(pi as any);
	const tool = pi.tools.get("apply_patch");
	expect(tool).toBeDefined();
	expect(tool.parameters.properties).toHaveProperty("input");
	expect(tool.parameters.properties).not.toHaveProperty("dryRun");
	expect(tool.description).not.toContain("dryRun");
});
