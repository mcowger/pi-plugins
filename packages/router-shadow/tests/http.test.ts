import { expect, test } from "bun:test";
import { createHttp } from "../src/http.js";

function stubFetch(
	behavior: (
		call: number,
		init: RequestInit,
	) => Promise<{ status: number; text(): Promise<string> }>,
	calls: { init: RequestInit }[],
) {
	return async (_url: string, init: RequestInit) => {
		calls.push({ init });
		return behavior(calls.length, init);
	};
}

const ok = (payload: unknown) => ({
	status: 200,
	text: async () => JSON.stringify(payload),
});

test("retries once on 429 then succeeds", async () => {
	const calls: { init: RequestInit }[] = [];
	const sleeps: number[] = [];
	const { postJson } = createHttp({
		apiBase: "https://plexus.example",
		apiKey: "k",
		fetchImpl: stubFetch(
			async (call) =>
				call === 1
					? { status: 429, text: async () => "slow down" }
					: ok({ hello: "world" }),
			calls,
		),
		sleepImpl: async (ms) => {
			sleeps.push(ms);
		},
	});
	const result = await postJson("/v1/decisions", { a: 1 }, { timeoutMs: 1000 });
	expect(result.json).toEqual({ hello: "world" });
	expect(calls.length).toBe(2);
	expect(sleeps).toEqual([300]);
	// Bearer auth and no redirects.
	expect(calls[0].init.headers).toMatchObject({
		Authorization: "Bearer k",
		"Content-Type": "application/json",
	});
	expect(calls[0].init.redirect).toBe("error");
});

test("gives up after the retry with an http_ status error", async () => {
	const { postJson } = createHttp({
		apiBase: "https://plexus.example",
		apiKey: "k",
		fetchImpl: stubFetch(
			async () => ({
				status: 503,
				text: async () => "down",
			}),
			[],
		),
		sleepImpl: async () => {},
	});
	const err = await postJson("/v1/decisions", {}, { timeoutMs: 1000 }).then(
		() => null,
		(err: unknown) => err as Error,
	);
	expect(err?.message.startsWith("http_503")).toBe(true);
});

test("non-retryable status throws immediately", async () => {
	const calls: { init: RequestInit }[] = [];
	const { postJson } = createHttp({
		apiBase: "https://plexus.example",
		apiKey: "k",
		fetchImpl: stubFetch(
			async () => ({
				status: 400,
				text: async () => "bad",
			}),
			calls,
		),
		sleepImpl: async () => {
			throw new Error("must not sleep");
		},
	});
	const err = await postJson("/v1/decisions", {}, { timeoutMs: 1000 }).then(
		() => null,
		(err: unknown) => err as Error,
	);
	expect(err?.message.startsWith("http_400")).toBe(true);
	expect(calls.length).toBe(1);
});

type StubResponse = { status: number; text(): Promise<string> };

function hangForever(): Promise<StubResponse> {
	return new Promise<StubResponse>(() => {});
}

test("hanging transport hits the timeout even when it ignores abort", async () => {
	const { postJson } = createHttp({
		apiBase: "https://plexus.example",
		apiKey: "k",
		fetchImpl: hangForever,
	});
	const started = Date.now();
	const err = await postJson("/v1/embeddings", {}, { timeoutMs: 80 }).then(
		() => null,
		(err: unknown) => err as Error,
	);
	expect(err?.message).toBe("timeout");
	expect(Date.now() - started).toBeLessThan(2000);
});

test("aborted outer signal reads as aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const { postJson } = createHttp({
		apiBase: "https://plexus.example",
		apiKey: "k",
		fetchImpl: hangForever,
	});
	const err = await postJson(
		"/v1/embeddings",
		{},
		{ timeoutMs: 1000, abort: controller.signal },
	).then(
		() => null,
		(err: unknown) => err as Error,
	);
	expect(err?.message).toBe("aborted");
});

test("base ending in /v1 is not doubled; invalid bases throw", async () => {
	const seen: string[] = [];
	const { postJson } = createHttp({
		apiBase: "https://plexus.example/v1/",
		apiKey: "k",
		fetchImpl: (async (url: string) => {
			seen.push(url);
			return ok({});
		}) as (
			url: string,
			init: RequestInit,
		) => Promise<{ status: number; text(): Promise<string> }>,
	});
	await postJson("/v1/decisions", {}, { timeoutMs: 1000 });
	expect(seen).toEqual(["https://plexus.example/v1/decisions"]);

	const bad = createHttp({ apiBase: "not-a-url", apiKey: "k" });
	const err = await bad.postJson("/v1/decisions", {}, { timeoutMs: 100 }).then(
		() => null,
		(err: unknown) => err as Error,
	);
	expect(err).not.toBeNull();
});
