/**
 * Minimal HTTPS client (REQUIREMENTS R11, DESIGN §7).
 *
 * `fetch` with `redirect: "error"` (never forwards the bearer token),
 * per-call timeouts via `AbortSignal.timeout`, one retry after 300 ms for
 * HTTP 429/502/503/504 or network errors when time remains, and sanitized
 * error strings (no host, no key, bounded length).
 */

export type ApiPath =
	| "/v1/decisions"
	| "/v1/embeddings"
	| "/v1/chat/completions";

export type FetchImpl = (
	url: string,
	init: RequestInit,
) => Promise<{ status: number; text(): Promise<string> }>;

export interface HttpConfig {
	apiBase: string;
	apiKey: string;
	fetchImpl?: FetchImpl;
	sleepImpl?: (ms: number) => Promise<void>;
}

export interface PostArgs {
	timeoutMs: number;
	/** Session-level signal (e.g. shutdown): abort reads as "aborted". */
	abort?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAY_MS = 300;
const MAX_DETAIL_CHARS = 120;
const MAX_ERROR_CHARS = 200;

/** Join base + path without doubling `/v1` (R7.1). */
export function joinUrl(apiBase: string, path: ApiPath): string {
	const base = apiBase.replace(/\/+$/, "");
	if (!base) throw new Error("router-shadow: PLEXUS_API_BASE is empty");
	let scheme = "";
	let host = "";
	try {
		const parsed = new URL(base);
		scheme = parsed.protocol;
		host = parsed.host;
	} catch {
		throw new Error(
			"router-shadow: PLEXUS_API_BASE must be an absolute http(s) URL",
		);
	}
	if ((scheme !== "http:" && scheme !== "https:") || !host) {
		throw new Error(
			"router-shadow: PLEXUS_API_BASE must be an absolute http(s) URL",
		);
	}
	return base.endsWith("/v1") ? base + path.slice(3) : base + path;
}

/** Strip the API key and any host-like tokens from an error detail. */
export function sanitizeDetail(detail: string, secrets: string[]): string {
	let clean = String(detail);
	for (const secret of secrets) {
		if (secret) clean = clean.split(secret).join("[key]");
	}
	// Drop scheme://host prefixes without naming the host.
	clean = clean.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<]*/g, "[url]");
	if (Array.from(clean).length > MAX_DETAIL_CHARS) {
		const points = Array.from(clean);
		clean = `${points.slice(0, MAX_DETAIL_CHARS).join("")}…`;
	}
	return clean;
}

function errorString(code: string, detail?: string): string {
	const message = detail ? `${code}: ${detail}` : code;
	if (Array.from(message).length <= MAX_ERROR_CHARS) return message;
	return `${Array.from(message).slice(0, MAX_ERROR_CHARS).join("")}…`;
}

/** Rejects when `signal` aborts: "aborted" for the session signal, else "timeout". */
function abortRejected(
	signal: AbortSignal,
	session: AbortSignal | undefined,
): Promise<never> {
	const code = () => (session?.aborted ? "aborted" : "timeout");
	if (signal.aborted) return Promise.reject(new Error(code()));
	return new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(new Error(code())), {
			once: true,
		});
	});
}

function sleep(ms: number, sleepImpl?: HttpConfig["sleepImpl"]): Promise<void> {
	if (sleepImpl) return sleepImpl(ms);
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		// Background work must not keep pi alive (R11.4).
		(timer as unknown as { unref?: () => void }).unref?.();
	});
}

export function createHttp(config: HttpConfig) {
	const fetchImpl: FetchImpl =
		config.fetchImpl ??
		((url, init) => globalThis.fetch(url, init) as Promise<Response>);
	const secrets = config.apiKey ? [config.apiKey] : [];

	async function postJson(
		path: ApiPath,
		body: unknown,
		args: PostArgs,
	): Promise<{ json: unknown; ms: number }> {
		const url = joinUrl(config.apiBase, path);
		const started = Date.now();
		const deadline = started + args.timeoutMs;
		let attempt = 0;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(errorString("timeout"));
			const timeoutSignal = AbortSignal.timeout(remaining);
			const signal = args.abort
				? AbortSignal.any([args.abort, timeoutSignal])
				: timeoutSignal;
			let status = 0;
			let text = "";
			try {
				// Race the fetch against the abort: a transport that ignores
				// the signal must not defeat the per-call timeout (R11.1).
				const raced = await Promise.race([
					fetchImpl(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							Authorization: `Bearer ${config.apiKey}`,
						},
						body: JSON.stringify(body),
						redirect: "error",
						signal,
					}).then(async (response) => ({
						status: response.status,
						text: await response.text(),
					})),
					abortRejected(signal, args.abort),
				]);
				status = raced.status;
				text = raced.text;
			} catch (err) {
				if (args.abort?.aborted) throw new Error(errorString("aborted"));
				if (
					err instanceof Error &&
					(err.name === "AbortError" || err.message === "timeout")
				) {
					throw new Error(errorString("timeout"));
				}
				// Network error: retry once when time remains.
				if (attempt === 0 && Date.now() + RETRY_DELAY_MS < deadline) {
					attempt++;
					await sleep(RETRY_DELAY_MS, config.sleepImpl);
					continue;
				}
				throw new Error(
					errorString(
						"network",
						sanitizeDetail((err as Error).message ?? String(err), secrets),
					),
				);
			}
			if (RETRYABLE_STATUS.has(status)) {
				if (attempt === 0 && Date.now() + RETRY_DELAY_MS < deadline) {
					attempt++;
					await sleep(RETRY_DELAY_MS, config.sleepImpl);
					continue;
				}
				throw new Error(
					errorString(`http_${status}`, sanitizeDetail(text, secrets)),
				);
			}
			if (status < 200 || status >= 300) {
				throw new Error(
					errorString(`http_${status}`, sanitizeDetail(text, secrets)),
				);
			}
			try {
				return { json: JSON.parse(text), ms: Date.now() - started };
			} catch {
				throw new Error(
					errorString("invalid_json", sanitizeDetail(text, secrets)),
				);
			}
		}
	}

	return { postJson };
}

export type PostJson = ReturnType<typeof createHttp>["postJson"];
