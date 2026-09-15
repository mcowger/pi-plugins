import type { Model } from "@earendil-works/pi-ai";

export type WebSearchCommands = Record<string, unknown> & {
	search_query?: Array<{ q: string; recency?: number; domains?: string[] }>;
	image_query?: Array<{ q: string; recency?: number; domains?: string[] }>;
	response_length?: "short" | "medium" | "long";
};

export type WebSearchResponse = { output: string; results?: unknown[]; [key: string]: unknown };

export const WEB_SEARCH_DETAILS_LIMIT_BYTES = 50_000;

export function resolveWebSearchUrl(baseUrl?: string): string {
	const base = (baseUrl?.trim() || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (base.endsWith("/codex/alpha/search")) return base;
	return `${base.endsWith("/codex") ? base : `${base}/codex`}/alpha/search`;
}

function accountId(token: string): string {
	try {
		const payload = token.split(".")[1];
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return decoded["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
	} catch {
		return "";
	}
}

export function buildWebSearchHeaders(token: string, modelHeaders?: Record<string, string | null>, authHeaders?: Record<string, string | null>): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(modelHeaders ?? {})) value == null ? headers.delete(name) : headers.set(name, value);
	for (const [name, value] of Object.entries(authHeaders ?? {})) value == null ? headers.delete(name) : headers.set(name, value);
	headers.set("authorization", `Bearer ${token}`);
	const id = accountId(token);
	if (id && !headers.has("chatgpt-account-id")) headers.set("chatgpt-account-id", id);
	headers.set("originator", "pi-microgpt");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return headers;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item): item is { type: "text"; text: string } => !!item && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string").map((item) => item.text).join("\n");
}

export function buildWebSearchInput(branch: readonly any[]): Array<Record<string, unknown>> | undefined {
	const visible = branch.filter((entry) => entry?.type === "message").map((entry) => entry.message).filter((message) => message?.role === "user" || message?.role === "assistant").map((message) => ({ role: message.role, text: textFromContent(message.content) })).filter((message) => message.text.length > 0);
	let users = 0;
	let start = visible.length;
	for (let index = visible.length - 1; index >= 0; index--) {
		if (visible[index].role === "user") users++;
		start = index;
		if (users === 2) break;
	}
	const input = visible.slice(start).map((message) => ({ type: "message", role: message.role, content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }] }));
	return input.length ? input : undefined;
}

export async function fetchCodexWebSearch(options: { endpoint: string; token: string; model: Model<any>; authHeaders?: Record<string, string | null>; commands: WebSearchCommands; sessionId: string; input?: Array<Record<string, unknown>>; signal?: AbortSignal }): Promise<{ text: string; response: WebSearchResponse }> {
	const response = await fetch(options.endpoint, {
		method: "POST",
		headers: buildWebSearchHeaders(options.token, options.model.headers as Record<string, string | null> | undefined, options.authHeaders),
		body: JSON.stringify({ id: options.sessionId, model: options.model.id, ...(options.input ? { input: options.input } : {}), commands: options.commands, settings: { allowed_callers: ["direct"], external_web_access: true }, max_output_tokens: options.commands.response_length === "short" ? 2_000 : options.commands.response_length === "long" ? 10_000 : 5_000 }),
		signal: options.signal,
	});
	const responseText = await response.text();
	if (!response.ok) throw new Error(`Codex web search failed (${response.status}): ${responseText || response.statusText}`);
	let payload: WebSearchResponse;
	try { payload = JSON.parse(responseText) as WebSearchResponse; } catch (error) { throw new Error("Codex web search returned invalid JSON", { cause: error }); }
	if (typeof payload.output !== "string") throw new Error("Codex web search response did not include output");
	return { text: payload.output, response: payload };
}

export function boundedWebSearchDetails(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= WEB_SEARCH_DETAILS_LIMIT_BYTES) return text;
	const suffix = "\n… raw output truncated …";
	const bytes = Buffer.from(text, "utf8");
	let end = WEB_SEARCH_DETAILS_LIMIT_BYTES - Buffer.byteLength(suffix, "utf8");
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

export function summarizeWebSearchCommands(commands: WebSearchCommands): string {
	const queries = commands.search_query ?? commands.image_query;
	if (queries?.length) return queries.map((query) => query.q).join(", ");
	if (Array.isArray(commands.open) && commands.open[0]) return `open ${(commands.open[0] as any).ref_id}`;
	return "web";
}
