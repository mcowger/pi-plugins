import { describe, expect, it } from "bun:test";
import {
	defaultOperatorConfig,
	parseOperatorConfig,
	SubagentConfigError,
} from "../src/config.js";

describe("parseOperatorConfig", () => {
	it("defaults to maxDepth 1 and no approved extensions", () => {
		expect(parseOperatorConfig(undefined)).toEqual(defaultOperatorConfig());
		expect(defaultOperatorConfig().maxDepth).toBe(1);
	});

	it("accepts an explicit ceiling and approved extensions", () => {
		expect(
			parseOperatorConfig({
				maxDepth: 3,
				approvedExtensions: { research: "/abs/research.ts" },
				excludedExtensions: ["spawner"],
			}),
		).toEqual({
			maxDepth: 3,
			approvedExtensions: { research: "/abs/research.ts" },
			excludedExtensions: ["spawner"],
		});
	});

	it("rejects a non-finite or negative ceiling", () => {
		expect(() => parseOperatorConfig({ maxDepth: -1 })).toThrow(
			SubagentConfigError,
		);
		expect(() => parseOperatorConfig({ maxDepth: 1.5 })).toThrow(
			SubagentConfigError,
		);
		expect(() =>
			parseOperatorConfig({ maxDepth: Number.POSITIVE_INFINITY }),
		).toThrow(SubagentConfigError);
		expect(() => parseOperatorConfig({ maxDepth: "1" })).toThrow(
			SubagentConfigError,
		);
	});

	it("rejects malformed extension maps", () => {
		expect(() =>
			parseOperatorConfig({ approvedExtensions: { a: "" } }),
		).toThrow(SubagentConfigError);
		expect(() => parseOperatorConfig({ approvedExtensions: ["a"] })).toThrow(
			SubagentConfigError,
		);
		expect(() => parseOperatorConfig({ excludedExtensions: [""] })).toThrow(
			SubagentConfigError,
		);
	});
});
