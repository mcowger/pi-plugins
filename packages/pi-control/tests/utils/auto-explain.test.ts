import { describe, expect, it } from "bun:test";
import type {
	AutoBuckets,
	AutoProbabilities,
} from "../../src/utils/auto-decisions.js";
import {
	describeAutoVerdict,
	type ExplainInput,
	MAX_EXPLANATION,
} from "../../src/utils/auto-explain.js";
import type { AutoTarget } from "../../src/utils/auto-state.js";

const LOG: AutoTarget = {
	path: "/home/me/.pi/agent/extensions/pi-controls.log",
	scope: "outside",
};

const BUCKETS: AutoBuckets = {
	action_class: "local_read",
	scope: "outside",
	data_sensitivity: "sensitive",
	destructive: "no",
	network: "no",
	concealed: "no",
	inference_call: "no",
};

const PROBS: AutoProbabilities = {
	destructive: 0.04,
	concealed: 0.01,
	network: 0.01,
	inference_call: 0.01,
	scope: { outside: 1 },
	data_sensitivity: { ordinary: 0.25, sensitive: 0.7 },
};

function input(overrides: Partial<ExplainInput> = {}): ExplainInput {
	return {
		buckets: BUCKETS,
		probabilities: PROBS,
		scopeSource: "deterministic",
		stage1: { verdict: "ask", rule: "sensitive-read" },
		stage2: { score: 2, threshold: 40, breached: false, contributions: {} },
		...overrides,
	};
}

describe("describeAutoVerdict", () => {
	it("names the rule, its probabilities, what was not found, and the paths", () => {
		expect(describeAutoVerdict(input(), [LOG])).toBe(
			"rule sensitive-read: data_sensitivity=sensitive (sensitive 0.70, ordinary 0.25); " +
				"other signals: destructive=no, network=no, concealed=no; " +
				"scope=outside (from paths); " +
				"targets: /home/me/.pi/agent/extensions/pi-controls.log (outside)",
		);
	});

	it("lists undecided dimensions with their probabilities", () => {
		const detail = describeAutoVerdict(
			input({
				buckets: { ...BUCKETS, data_sensitivity: "uncertain" },
				probabilities: {
					...PROBS,
					data_sensitivity: { ordinary: 0.46, sensitive: 0.53 },
				},
				stage1: { verdict: "ask", rule: "uncertain-critical" },
			}),
			[LOG],
		);
		expect(detail).toContain(
			"rule uncertain-critical: classifier undecided on data_sensitivity (sensitive 0.53, ordinary 0.46)",
		);
		expect(detail).toContain(
			"other signals: destructive=no, network=no, concealed=no;",
		);
	});

	it("reports the backstop score and its top contributions", () => {
		const detail = describeAutoVerdict(
			input({
				buckets: { ...BUCKETS, data_sensitivity: "ordinary", scope: "within" },
				stage1: { verdict: null, rule: null },
				stage2: {
					score: 52,
					threshold: 40,
					breached: true,
					contributions: { scopeRisky: 30, concealed: 12, network: 10 },
				},
				scopeSource: "model",
			}),
			[],
		);
		expect(detail).toBe(
			"backstop score 52 ≥ 40 (scopeRisky 30 + concealed 12 + network 10); " +
				"other signals: destructive=no, network=no, concealed=no, data_sensitivity=ordinary; " +
				"scope=within (model); targets: none",
		);
	});

	it("elides long target lists and caps the length", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({
			path: `/p/${i}`,
			scope: "outside" as const,
		}));
		expect(describeAutoVerdict(input(), many)).toContain("+2 more");
		const long = Array.from({ length: 3 }, (_, i) => ({
			path: `/${"x".repeat(200)}/${i}`,
			scope: "outside" as const,
		}));
		const detail = describeAutoVerdict(input(), long);
		expect(detail.length).toBe(MAX_EXPLANATION);
		expect(detail.endsWith("…")).toBe(true);
	});
});
