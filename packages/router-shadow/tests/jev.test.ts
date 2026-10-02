import { expect, test } from "bun:test";
import {
	type Bundle,
	exemplarLine,
	loadBundle,
	type Tier,
} from "../src/bundle.js";
import type { BoundedState } from "../src/context/bounded.js";
import {
	jevRequestBody,
	jevZeroShotRequestBody,
	parseJevResponse,
} from "../src/route/jev.js";

interface JevFixture {
	endpoint: string;
	jev_all_request: unknown;
	jev_zeroshot_request: unknown;
	example_response: unknown;
	expected_parse: {
		tier: Tier;
		tier_expected: number;
		confidence: number;
		input_tokens: number;
		cost: number;
	};
	invalid_response_examples: unknown[];
}

const bundle = loadBundle(
	JSON.parse(
		await Bun.file(new URL("../exemplars.json", import.meta.url)).text(),
	),
) as Bundle;

const fixture = JSON.parse(
	await Bun.file(new URL("./fixtures/jev.json", import.meta.url)).text(),
) as JevFixture;

test("jev-all request body matches the fixture", () => {
	const state = fixture.jev_all_request as {
		state: BoundedState;
		questions: { tier: { instructions: string } };
	};
	// The fixture uses all bundle items with no leakage-guard exclusions.
	const lines = bundle.items.map(exemplarLine).join("\n");
	const body = jevRequestBody("jev-1.13", state.state, lines);
	expect(JSON.parse(JSON.stringify(body))).toEqual(fixture.jev_all_request);
});

test("jev-zeroshot request body matches the fixture", () => {
	const state = fixture.jev_zeroshot_request as { state: BoundedState };
	const body = jevZeroShotRequestBody("jev-1.13", state.state);
	expect(JSON.parse(JSON.stringify(body))).toEqual(
		fixture.jev_zeroshot_request,
	);
});

test("parsing the example response matches expected_parse", () => {
	const parsed = parseJevResponse(fixture.example_response);
	expect(parsed.tier).toBe(fixture.expected_parse.tier);
	expect(parsed.tier_expected).toBe(fixture.expected_parse.tier_expected);
	expect(parsed.confidence).toBe(fixture.expected_parse.confidence);
	expect(parsed.input_tokens).toBe(fixture.expected_parse.input_tokens);
	expect(parsed.cost).toBe(fixture.expected_parse.cost);
	expect(parsed.probs).toEqual({
		economy: 0.1,
		standard: 0.7,
		high: 0.15,
		premium: 0.05,
	});
});

for (const [index, invalid] of fixture.invalid_response_examples.entries()) {
	test(`invalid response ${index} produces an error`, () => {
		expect(() => parseJevResponse(invalid)).toThrow();
	});
}
