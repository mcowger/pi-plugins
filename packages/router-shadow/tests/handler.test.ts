import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	jevBody,
	makeHarness,
	readRecords,
	userBranch,
	waitForRecords,
} from "./harness.js";

let realFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
	if (realFetch) {
		globalThis.fetch = realFetch;
		realFetch = undefined;
	}
});

const seenRequests: { url: string; auth: string | null }[] = [];

function stubFetch(handler: (url: string) => unknown) {
	realFetch ??= globalThis.fetch;
	seenRequests.length = 0;
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		const headers = (init as { headers?: Record<string, string> })?.headers;
		seenRequests.push({
			url: String(url),
			auth: headers?.Authorization ?? null,
		});
		return {
			status: 200,
			text: async () => JSON.stringify(handler(String(url))),
		};
	}) as unknown as typeof globalThis.fetch;
}

function hangFetch() {
	realFetch ??= globalThis.fetch;
	globalThis.fetch = (() =>
		new Promise(() => {})) as unknown as typeof globalThis.fetch;
}

function embeddingStub(url: string) {
	if (url.endsWith("/v1/embeddings")) {
		return { data: [{ index: 0, embedding: new Array(1536).fill(0.01) }] };
	}
	return jevBody("standard");
}

test(
	"R14#6: handler returns in under 5 ms with hanging network; timeout recorded",
	async () => {
		hangFetch();
		const prompt = "refactor the thing";
		const harness = await makeHarness({ branch: userBranch(prompt) });
		const started = Date.now();
		const result = harness.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt },
			harness.ctx(),
		);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(5);
		// The turn proceeds: no modification is returned.
		expect(result).toBeUndefined();

		const records = await waitForRecords(harness.logDir, 1, 8000);
		expect(records.length).toBe(1);
		const candidates = records[0].candidates as Record<
			string,
			{ error: string | null }
		>;
		expect(candidates["jev-all"].error).toBe("timeout");
		expect(candidates["jev-zeroshot"].error).toBe("timeout");
		expect(candidates["jev-k24"].error).toBe("timeout");
		expect((records[0].embedding as { error: string | null }).error).toBe(
			"timeout",
		);
	},
	{ timeout: 15000 },
);

test("R14#8: no log line contains a sentinel from the prompt", async () => {
	const sentinel = "SENTINEL_9f8a7b6c5d4e";
	stubFetch(embeddingStub);
	const prompt = `fix the ${sentinel} login flow`;
	const harness = await makeHarness({ branch: userBranch(prompt) });
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records.length).toBe(1);
	const files = await readdir(harness.logDir);
	let bytes = "";
	for (const file of files) {
		bytes += await readFile(join(harness.logDir, file), "utf8");
	}
	expect(bytes).not.toContain(sentinel);
	expect(bytes.toLowerCase()).not.toContain(sentinel.toLowerCase());
	// The turn still routed normally.
	const candidates = records[0].candidates as Record<
		string,
		{ tier: string; error: string | null }
	>;
	expect(candidates["jev-all"].tier).toBe("standard");
	expect(candidates["jev-all"].error).toBeNull();
});

test("settle waits for a late-landing prompt entry instead of null", async () => {
	stubFetch(embeddingStub);
	const prompt = "late landing prompt";
	const harness = await makeHarness({ branch: [] });
	let calls = 0;
	harness.sessionManager.getBranch = () => {
		calls++;
		return calls > 3 ? userBranch(prompt) : [];
	};
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 10000);
	expect(records.length).toBe(1);
	expect(records[0].entry_id).toBe("u1");
});

test("R14#7: parentSession header tags subagent origin", async () => {
	stubFetch(embeddingStub);
	const prompt = "run the delegated tests";
	const harness = await makeHarness({
		header: { parentSession: "/sessions/parent.jsonl" },
		branch: userBranch(prompt),
	});
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records[0].origin).toBe("subagent");
	expect(records[0].is_subagent_session).toBe(true);
	expect((records[0].actual as { source: string }).source).toBe(
		"subagent_config",
	);
});

test("R14#7: delegated-task prefix tags subagent origin", async () => {
	stubFetch(embeddingStub);
	const prompt = "Task: You are a delegated subagent. Explore the repo.";
	const harness = await makeHarness({ branch: userBranch(prompt) });
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records[0].origin).toBe("subagent");
});

test("inherits the plexus provider key when no static key is configured", async () => {
	stubFetch(embeddingStub);
	const prompt = "registry key turn";
	const harness = await makeHarness({
		branch: userBranch(prompt),
		settings: { apiKey: "" },
	});
	withCleanPlexusEnv(() => {
		harness.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt },
			harness.ctx({
				modelRegistry: {
					getApiKeyForProvider: async (provider: string) => {
						expect(provider).toBe("plexus");
						return "registry-key-123";
					},
				},
			}),
		);
	});
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records.length).toBe(1);
	expect(records[0].skipped).toBeNull();
	const candidates = records[0].candidates as Record<
		string,
		{ tier: string; error: string | null }
	>;
	expect(candidates["jev-all"].tier).toBe("standard");
	// Every network call carried the inherited key.
	expect(seenRequests.length).toBeGreaterThan(0);
	for (const request of seenRequests) {
		expect(request.auth).toBe("Bearer registry-key-123");
	}
});

// The dev shell may export real PLEXUS_* vars; these tests need them gone.
// config() reads env synchronously in the handler, so restore right after.
function withCleanPlexusEnv(fn: () => void): void {
	const names = [
		"PLEXUS_API_KEY",
		"PLEXUS_API_BASE",
		"PLEXUS_API_URL",
		"PLEXUS_BASE_URL",
	] as const;
	const saved = names.map((name) => process.env[name]);
	for (const name of names) delete process.env[name];
	try {
		fn();
	} finally {
		names.forEach((name, index) => {
			if (saved[index] === undefined) delete process.env[name];
			else process.env[name] = saved[index];
		});
	}
}

test("logs missing-credentials skip when no key resolves anywhere", async () => {
	let fetched = false;
	realFetch ??= globalThis.fetch;
	globalThis.fetch = (async () => {
		fetched = true;
		return { status: 200, text: async () => "{}" };
	}) as unknown as typeof globalThis.fetch;
	const prompt = "keyless turn";
	const harness = await makeHarness({
		branch: userBranch(prompt),
		settings: { apiKey: "" },
	});
	withCleanPlexusEnv(() => {
		harness.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt },
			harness.ctx(),
		);
	});
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records.length).toBe(1);
	expect(records[0].skipped).toBe("missing-credentials");
	expect(fetched).toBe(false);
});

test("R14#7: interactive input tags human origin with user_selection", async () => {
	stubFetch((url) => {
		if (url.endsWith("/v1/embeddings")) {
			return { data: [{ index: 0, embedding: new Array(1536).fill(0.01) }] };
		}
		return jevBody("high");
	});
	const prompt = "debug the flaky test";
	const harness = await makeHarness({
		branch: [
			{
				type: "model_change",
				id: "m1",
				parentId: null,
			},
			...userBranch(prompt).map((entry, index) => ({
				...entry,
				id: `u${index + 2}`,
				parentId: index === 0 ? "m1" : `u${index + 1}`,
			})),
		],
	});
	harness.fire("input", { type: "input", text: prompt, source: "interactive" });
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records[0].origin).toBe("human");
	const actual = records[0].actual as {
		source: string;
		tier: string;
		model: string;
		provider: string;
	};
	expect(actual.source).toBe("user_selection");
	expect(actual.tier).toBe("standard");
	expect(actual.model).toBe("gpt-6-luna");
	expect(actual.provider).toBe("plexus");
});
