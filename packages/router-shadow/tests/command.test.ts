import { afterEach, expect, test } from "bun:test";
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

function stubFetch(handler: (url: string) => unknown, delayMs = 0) {
	realFetch ??= globalThis.fetch;
	globalThis.fetch = (async (url: unknown) => {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return {
			status: 200,
			text: async () => JSON.stringify(handler(String(url))),
		};
	}) as unknown as typeof globalThis.fetch;
}

function embeddingStub(url: string) {
	if (url.endsWith("/v1/embeddings")) {
		return { data: [{ index: 0, embedding: new Array(1536).fill(0.01) }] };
	}
	return jevBody("standard");
}

test("R11.2: a third concurrent turn is skipped with backpressure", async () => {
	stubFetch(embeddingStub, 300);
	const harness = await makeHarness({ branch: userBranch("turn prompt") });
	for (const prompt of ["turn one", "turn two", "turn three"]) {
		harness.fire(
			"before_agent_start",
			{ type: "before_agent_start", prompt },
			harness.ctx(),
		);
	}
	const records = await waitForRecords(harness.logDir, 3, 10000);
	expect(records.length).toBe(3);
	const skipped = records.filter((record) => record.skipped === "backpressure");
	expect(skipped.length).toBe(1);
	expect(records.filter((record) => record.skipped === null).length).toBe(2);
});

test("/router-shadow status reports routed counts and mixes", async () => {
	stubFetch(embeddingStub);
	const harness = await makeHarness({ branch: userBranch("status turn") });
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt: "status turn" },
		harness.ctx(),
	);
	await waitForRecords(harness.logDir, 1, 8000);
	await harness.runCommand("router-shadow", "status");
	const text = harness.ui.notices.map((notice) => notice.message).join("\n");
	expect(text).toContain("1 routed, 0 skipped");
	expect(text).toContain("jev-all");
	expect(text).toContain("jev-k24");
	expect(text).toContain("jev-zeroshot");
});

test("/router-shadow off stops routing and persists the toggle", async () => {
	stubFetch(embeddingStub);
	const harness = await makeHarness({ branch: userBranch("off turn") });
	await harness.runCommand("router-shadow", "off");
	expect(
		harness.appended.some(
			(entry) => entry.customType === "router-shadow-toggle",
		),
	).toBe(true);
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt: "off turn" },
		harness.ctx(),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(await readRecords(harness.logDir)).toEqual([]);
	await harness.runCommand("router-shadow", "on");
	harness.fire(
		"before_agent_start",
		{ type: "before_agent_start", prompt: "off turn" },
		harness.ctx(),
	);
	const records = await waitForRecords(harness.logDir, 1, 8000);
	expect(records.length).toBe(1);
});
