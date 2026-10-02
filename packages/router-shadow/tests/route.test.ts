import { expect, test } from "bun:test";
import { type Bundle, loadBundle } from "../src/bundle.js";
import { buildBoundedState } from "../src/context/bounded.js";
import { entriesToMessages } from "../src/context/entries.js";
import type { PostJson } from "../src/http.js";
import { route } from "../src/route/route.js";

const bundle = loadBundle(
	JSON.parse(
		await Bun.file(new URL("../exemplars.json", import.meta.url)).text(),
	),
) as Bundle;

function jevResponse(tier: string) {
	return {
		answers: {
			tier: {
				type: "choice",
				choice: tier,
				probabilities: {
					economy: 0.7,
					standard: 0.2,
					high: 0.08,
					premium: 0.02,
				},
				confidence: 0.5,
			},
		},
		usage: { input_tokens: 100, output_tokens: 5, cost: 0.00001 },
	};
}

/** Minimal state built through the real pipeline. */
function testState() {
	const messages = entriesToMessages([], "do the thing", false);
	return buildBoundedState(messages);
}

function stubPost(
	handlers: Record<string, (body: unknown) => unknown>,
	calls: string[],
): PostJson {
	return (async (path: string, body: unknown) => {
		calls.push(path);
		const handler = handlers[path];
		if (!handler) throw new Error(`http_500: no stub for ${path}`);
		return { json: handler(body), ms: 1 };
	}) as PostJson;
}

test("all default candidates populate; one shared embedding call", async () => {
	const calls: string[] = [];
	const post = stubPost(
		{
			"/v1/decisions": (body) => {
				const questions = (
					body as { questions: { tier: { instructions: string } } }
				).questions;
				return questions.tier.instructions.includes(
					"resemble this one, each with",
				)
					? jevResponse("standard")
					: jevResponse("economy");
			},
			"/v1/embeddings": () => ({
				data: [{ index: 0, embedding: bundle.items[0].vector }],
			}),
		},
		calls,
	);
	const output = await route(
		{
			state: testState(),
			prompt: "do the thing",
			candidates: ["jev-all", "jev-k24", "jev-zeroshot"],
			k: 24,
		},
		{ post, bundle, jevModel: "jev-1.13" },
	);
	expect(output.candidates["jev-all"].tier).toBe("standard");
	expect(output.candidates["jev-all"].excluded_exemplars).toBe(0);
	expect(output.candidates["jev-zeroshot"].tier).toBe("economy");
	expect(output.candidates["jev-k24"].tier).toBe("standard");
	expect(output.candidates["jev-k24"].exemplars?.length).toBe(24);
	expect(output.embedding.error).toBeNull();
	expect(calls.filter((c) => c === "/v1/embeddings").length).toBe(1);
	expect(calls.filter((c) => c === "/v1/decisions").length).toBe(3);
});

test("embedding failure fails k24 but not the direct candidates", async () => {
	const calls: string[] = [];
	const post = stubPost(
		{
			"/v1/decisions": () => jevResponse("high"),
			"/v1/embeddings": () => {
				throw new Error("timeout");
			},
		},
		calls,
	);
	const output = await route(
		{
			state: testState(),
			prompt: "do the thing",
			candidates: ["jev-all", "jev-k24", "jev-zeroshot"],
			k: 24,
		},
		{ post, bundle, jevModel: "jev-1.13" },
	);
	expect(output.candidates["jev-all"].tier).toBe("high");
	expect(output.candidates["jev-zeroshot"].tier).toBe("high");
	expect(output.candidates["jev-k24"].tier).toBeNull();
	expect(output.candidates["jev-k24"].error).toBe("timeout");
	expect(output.embedding.error).toBe("timeout");
});

test("unknown candidate ids record an error", async () => {
	const post = stubPost({}, []);
	const output = await route(
		{ state: testState(), prompt: "x", candidates: ["nope"], k: 24 },
		{ post, bundle, jevModel: "jev-1.13" },
	);
	expect(output.candidates["nope"].error).toBe("unknown_candidate");
});
