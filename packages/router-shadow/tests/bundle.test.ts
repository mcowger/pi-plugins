import { expect, test } from "bun:test";
import {
	type Bundle,
	type Exemplar,
	exemplarLine,
	guardHashesForPrompt,
	isGuardExcluded,
	loadBundle,
	makePreview,
	topK,
} from "../src/bundle.js";

interface ExemplarsFixture {
	line_format: string;
	lines_first_3: string[];
	preview_examples: { prompt: string; expected_preview: string }[];
	topk_query_key: string;
	topk_expected_keys: string[];
}

const bundle = loadBundle(
	JSON.parse(
		await Bun.file(new URL("../exemplars.json", import.meta.url)).text(),
	),
) as Bundle;

const fixture = JSON.parse(
	await Bun.file(new URL("./fixtures/exemplars.json", import.meta.url)).text(),
) as ExemplarsFixture;

test("exemplar line format and first 3 lines", () => {
	expect(fixture.line_format).toBe("- [<tier>] <preview>");
	expect(bundle.items.slice(0, 3).map(exemplarLine)).toEqual(
		fixture.lines_first_3,
	);
});

for (const p of fixture.preview_examples) {
	test(`preview: ${JSON.stringify(p.prompt.slice(0, 24))}`, () => {
		expect(makePreview(p.prompt)).toBe(p.expected_preview);
	});
}

test("top-24 for the query item, guard triggered by its own hashes", () => {
	const query = bundle.items.find(
		(item: Exemplar) => item.key === fixture.topk_query_key,
	);
	expect(query).toBeDefined();
	// The full prompts aren't shipped; the guard is triggered with the item's
	// own stored hashes, exactly as the experiment's fixture does.
	const guard = {
		full: query!.prompt_norm_hash,
		prefix: query!.prompt_prefix_hash,
	};
	expect(isGuardExcluded(query!, guard)).toBe(true);
	const top = topK(bundle, query!.vector, 24, guard);
	expect(top.map((item) => item.key)).toEqual(fixture.topk_expected_keys);
});

test("bundle has 113 items with the expected tier counts (R8.2)", () => {
	expect(bundle.items.length).toBe(113);
	const counts: Record<string, number> = {};
	for (const item of bundle.items) {
		counts[item.tier] = (counts[item.tier] ?? 0) + 1;
	}
	expect(counts).toEqual({ economy: 42, standard: 40, high: 22, premium: 9 });
	expect(bundle.counts).toEqual(counts);
});

test("guard hashes: normalization matches the bundle builder", () => {
	// Whitespace/case variants of one prompt must hash identically.
	const a = guardHashesForPrompt("  Fix   the\nbuild  ");
	const b = guardHashesForPrompt("fix the build");
	expect(a).toEqual(b);
});

test("loadBundle rejects bad shapes", () => {
	expect(() => loadBundle(null)).toThrow();
	expect(() => loadBundle({})).toThrow();
	expect(() => loadBundle({ ...bundle, items: [] })).toThrow();
	expect(() =>
		loadBundle({
			...bundle,
			items: [{ ...bundle.items[0], tier: "ultra" }],
		}),
	).toThrow();
	expect(() =>
		loadBundle({
			...bundle,
			items: [{ ...bundle.items[0], vector: [0.5] }],
		}),
	).toThrow();
});
