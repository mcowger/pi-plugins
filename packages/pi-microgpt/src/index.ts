import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringEnum, type Api, type Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSupportedModel } from "./model-support.ts";
import {
	CODEX_APPLY_PATCH_FLAG,
	resolveCodexExecutable,
} from "./codex-binary.ts";
import {
	buildWebSearchInput,
	boundedWebSearchDetails,
	fetchCodexWebSearch,
	resolveWebSearchUrl,
	type WebSearchCommands,
} from "./web-search.ts";

export const MAX_CONTEXT_WINDOW = 1_050_000;
export const FAST_SERVICE_TIER = "priority";
export { isResponsesModel, isSupportedModel, RESPONSES_APIS, SUPPORTED_MODEL_SLUG } from "./model-support.ts";

const replacedTools = ["edit", "write"];

type PiModel = Model<Api>;

export function shouldApplyFastMode(model: PiModel | undefined, payload: unknown): boolean {
	if (!isSupportedModel(model) || !payload || typeof payload !== "object") return false;
	return (payload as { model?: unknown }).model === model.id;
}

export function withFastServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	return { ...(payload as Record<string, unknown>), service_tier: FAST_SERVICE_TIER };
}

type ParsedCommand = { action: string; requestId?: string; value?: boolean };

function parseCommand(args: string): ParsedCommand | undefined {
	const trimmed = args.trim();
	if (!trimmed) return { action: "toggle" };
	if (trimmed.startsWith("{")) {
		try {
			const request = JSON.parse(trimmed) as Record<string, unknown>;
			if (!request || typeof request.action !== "string") return undefined;
			return {
				action: request.action.trim().toLowerCase(),
				...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
				...(typeof request.value === "boolean" ? { value: request.value } : {}),
			};
		} catch {
			return undefined;
		}
	}
	const words = trimmed.toLowerCase().split(/\s+/);
	if (words.length === 1) return { action: words[0] };
	return undefined;
}

function response(command: string, success: boolean, payload: Record<string, unknown> = {}, requestId?: string): string {
	return JSON.stringify({ type: "pi-microgpt.response", command, success, ...(requestId ? { requestId } : {}), ...payload });
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, level);
}

function modelInfo(model: PiModel | undefined): Record<string, unknown> {
	return model ? { provider: model.provider, model: model.id, api: model.api } : {};
}

function pathsFromPatch(patch: string): string[] {
	const paths = new Set<string>();
	for (const line of patch.split("\n")) {
		const path = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/)?.[1];
		const move = line.match(/^\*\*\* Move to: (.+)$/)?.[1];
		if (path) paths.add(path);
		if (move) paths.add(move);
	}
	return [...paths];
}

const applyPatchSchema = Type.Object({
	patch: Type.String({ description: "Complete *** Begin Patch ... *** End Patch payload" }),
});

const searchQuerySchema = Type.Object({
	q: Type.String(),
	recency: Type.Optional(Type.Integer({ minimum: 0 })),
	domains: Type.Optional(Type.Array(Type.String())),
});

const webSearchSchema = Type.Object({
	search_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 4 })),
	image_query: Type.Optional(Type.Array(searchQuerySchema, { maxItems: 2 })),
	open: Type.Optional(Type.Array(Type.Object({ ref_id: Type.String(), lineno: Type.Optional(Type.Integer({ minimum: 0 })) }))),
	click: Type.Optional(Type.Array(Type.Object({ ref_id: Type.String(), id: Type.Integer({ minimum: 0 }) }))),
	find: Type.Optional(Type.Array(Type.Object({ ref_id: Type.String(), pattern: Type.String() }))),
	screenshot: Type.Optional(Type.Array(Type.Object({ ref_id: Type.String(), pageno: Type.Integer({ minimum: 0 }) }))),
	finance: Type.Optional(Type.Array(Type.Object({ ticker: Type.String(), type: StringEnum(["equity", "fund", "crypto", "index"] as const), market: Type.Optional(Type.String()) }))),
	weather: Type.Optional(Type.Array(Type.Object({ location: Type.String(), start: Type.Optional(Type.String()), duration: Type.Optional(Type.Integer({ minimum: 1 })) }))),
	sports: Type.Optional(Type.Array(Type.Object({ tool: Type.Optional(StringEnum(["sports"] as const)), fn: StringEnum(["schedule", "standings"] as const), league: StringEnum(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const), team: Type.Optional(Type.String()), opponent: Type.Optional(Type.String()), date_from: Type.Optional(Type.String()), date_to: Type.Optional(Type.String()), num_games: Type.Optional(Type.Integer({ minimum: 1 })), locale: Type.Optional(Type.String()) }))),
	time: Type.Optional(Type.Array(Type.Object({ utc_offset: Type.String() }))),
	response_length: Type.Optional(StringEnum(["short", "medium", "long"] as const)),
}) as any;

type ToolContext = ExtensionContext & {
	modelRegistry: ExtensionContext["modelRegistry"];
	sessionManager: ExtensionContext["sessionManager"];
};

export default function piMicroGpt(pi: ExtensionAPI): void {
	let longContextModel: PiModel | undefined;
	let previousContextWindow = 0;
	let fastEnabled = false;
	let webSearchEnabled = false;
	let applyPatchSelected: boolean | undefined;
	let webSearchSelected: boolean | undefined;
	const removedTools = new Set<string>();

	function setLongContext(enabled: boolean, model: PiModel | undefined): boolean {
		if (enabled) {
			if (longContextModel || !model || !isSupportedModel(model)) return false;
			longContextModel = model;
			previousContextWindow = model.contextWindow;
			model.contextWindow = Math.max(model.contextWindow, MAX_CONTEXT_WINDOW);
			return true;
		}
		if (!longContextModel) return false;
		longContextModel.contextWindow = previousContextWindow;
		longContextModel = undefined;
		previousContextWindow = 0;
		return true;
	}

	function syncTools(model: PiModel | undefined): void {
		const active = new Set(pi.getActiveTools());
		applyPatchSelected ??= active.has("apply_patch") || active.has("edit") || active.has("write");
		webSearchSelected ??= true;
		if (isSupportedModel(model) && applyPatchSelected) {
			active.add("apply_patch");
			for (const tool of replacedTools) if (active.delete(tool)) removedTools.add(tool);
		} else {
			active.delete("apply_patch");
			for (const tool of removedTools) active.add(tool);
			removedTools.clear();
		}
		if (isSupportedModel(model) && webSearchEnabled && webSearchSelected) active.add("web_search");
		else active.delete("web_search");
		pi.setActiveTools([...active]);
	}

	function emitCommand(command: string, ctx: ExtensionCommandContext, success: boolean, payload: Record<string, unknown>, requestId?: string, level: "info" | "warning" | "error" = "info"): void {
		notify(ctx, response(command, success, payload, requestId), level);
	}

	pi.registerCommand("long-context", {
		description: "Toggle the Responses API long context window",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			if (!request || !["toggle", "on", "off", "status"].includes(request.action)) {
				emitCommand("long-context", ctx, false, { error: "Expected on, off, status, or a JSON request." }, request?.requestId, "warning");
				return;
			}
			const enabled = longContextModel === ctx.model;
			if (request.action === "status") {
				emitCommand("long-context", ctx, true, { enabled, supported: isSupportedModel(ctx.model), contextWindow: ctx.model?.contextWindow, ...modelInfo(ctx.model) }, request.requestId);
				return;
			}
			const next = request.action === "on" || (request.action === "toggle" && !enabled);
			if (!setLongContext(next, ctx.model)) {
				emitCommand("long-context", ctx, false, { error: next ? "Current model does not support long context or it is already enabled." : "Long context is not enabled." , supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, request.requestId, "warning");
				return;
			}
			emitCommand("long-context", ctx, true, { enabled: next, supported: true, contextWindow: ctx.model?.contextWindow, ...modelInfo(ctx.model) }, request.requestId);
		},
	});

	pi.registerCommand("long-context-status", {
		description: "Report long context as JSON",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			const requestId = args.trim().startsWith("{") ? request?.requestId : args.trim() || undefined;
			emitCommand("long-context", ctx, true, { enabled: longContextModel === ctx.model, supported: isSupportedModel(ctx.model), contextWindow: ctx.model?.contextWindow, ...modelInfo(ctx.model) }, requestId);
		},
	});

	pi.registerCommand("fast", {
		description: "Toggle Responses API Fast mode",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			if (!request || !["toggle", "on", "off", "status"].includes(request.action)) {
				emitCommand("fast", ctx, false, { error: "Expected on, off, status, or a JSON request." }, request?.requestId, "warning");
				return;
			}
			if (request.action === "status") {
				emitCommand("fast", ctx, true, { enabled: fastEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, request.requestId);
				return;
			}
			fastEnabled = request.action === "on" || (request.action === "toggle" && !fastEnabled);
			emitCommand("fast", ctx, true, { enabled: fastEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, request.requestId);
		},
	});

	pi.registerCommand("fast-status", {
		description: "Report Fast mode as JSON",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			const requestId = args.trim().startsWith("{") ? request?.requestId : args.trim() || undefined;
			emitCommand("fast", ctx, true, { enabled: fastEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, requestId);
		},
	});

	pi.registerCommand("web-search", {
		description: "Enable or disable the Codex web search tool",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			if (!request || !["toggle", "on", "off", "status"].includes(request.action)) {
				emitCommand("web-search", ctx, false, { error: "Expected on, off, status, or a JSON request." }, request?.requestId, "warning");
				return;
			}
			if (request.action === "status") {
				emitCommand("web-search", ctx, true, { enabled: webSearchEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, request.requestId);
				return;
			}
			webSearchEnabled = request.action === "on" || (request.action === "toggle" && !webSearchEnabled);
			syncTools(ctx.model);
			emitCommand("web-search", ctx, true, { enabled: webSearchEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, request.requestId);
		},
	});

	pi.registerCommand("web-search-status", {
		description: "Report web search as JSON",
		handler: async (args, ctx) => {
			const request = parseCommand(args);
			const requestId = args.trim().startsWith("{") ? request?.requestId : args.trim() || undefined;
			emitCommand("web-search", ctx, true, { enabled: webSearchEnabled, supported: isSupportedModel(ctx.model), ...modelInfo(ctx.model) }, requestId);
		},
	});

	const applyPatch = {
		name: "apply_patch",
		label: "Apply Patch",
		description: "Apply a complete OpenAI Codex patch. Do not wrap the patch in JSON.",
		promptSnippet: "Apply an OpenAI Codex patch to add, update, move, or delete files",
		parameters: applyPatchSchema,
		constrainedSampling: { type: "grammar", variants: { openai_lark: readFileSync(fileURLToPath(new URL("../apply-patch.lark", import.meta.url)), "utf8") } },
		executionMode: "sequential",
		async execute(_toolCallId, { patch }, _signal, _onUpdate, ctx) {
			const result = await pi.exec(resolveCodexExecutable(), [CODEX_APPLY_PATCH_FLAG, patch], { cwd: ctx.cwd, signal: _signal });
			const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n") || (result.code === 0 ? "Patch applied successfully." : `Codex apply_patch exited with status ${result.code}`);
			if (result.code !== 0) throw new Error(output);
			return { content: [{ type: "text", text: output }], details: { paths: pathsFromPatch(patch), output } };
		},
	} as ToolDefinition<typeof applyPatchSchema> & { constrainedSampling?: unknown };
	pi.registerTool(applyPatch);

	const webSearch: ToolDefinition<typeof webSearchSchema> = {
		name: "web_search",
		label: "Web Search",
		description: "Search and browse the live web using OpenAI Codex search.",
		promptSnippet: "Search current web information through OpenAI Codex",
		parameters: webSearchSchema,
		async execute(_toolCallId, commands, signal, _onUpdate, rawCtx) {
			const ctx = rawCtx as ToolContext;
			const model = ctx.model;
			if (!isSupportedModel(model)) throw new Error("web_search requires a supported Responses API model");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Codex OAuth token is unavailable" : auth.error);
			const result = await fetchCodexWebSearch({
				endpoint: resolveWebSearchUrl(model.baseUrl),
				token: auth.apiKey,
				model,
				authHeaders: auth.headers as Record<string, string | null> | undefined,
				commands: commands as WebSearchCommands,
				sessionId: ctx.sessionManager.getSessionId(),
				input: buildWebSearchInput(ctx.sessionManager.getBranch()),
				signal,
			});
			return { content: [{ type: "text", text: result.text }], details: { commands, rawOutput: boundedWebSearchDetails(result.text), results: result.response.results } };
		},
	};
	pi.registerTool(webSearch);

	pi.on("session_start", (_event, ctx) => {
		setLongContext(false, longContextModel);
		fastEnabled = false;
		webSearchEnabled = false;
		syncTools(ctx.model);
	});
	pi.on("model_select", (event, ctx) => {
		setLongContext(false, longContextModel);
		syncTools(event.model);
	});
	pi.on("session_shutdown", () => {
		setLongContext(false, longContextModel);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (fastEnabled && shouldApplyFastMode(ctx.model, event.payload)) return withFastServiceTier(event.payload);
		return undefined;
	});
}
