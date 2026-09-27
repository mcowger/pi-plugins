import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyStage1,
	bucketAnswers,
	buildState,
	classifySource,
	clearEvalCache,
	evalCacheKey,
	getCachedVerdict,
	scoreBackstop,
	setCachedVerdict,
	verdictRationale,
	DecisionsError,
	type DecisionsAnswer,
	type DecisionsConfig,
} from "../../src/utils/decisions.js";
import { resolveDecisions } from "../../src/config.js";

function testConfig(overrides: Record<string, unknown> = {}): DecisionsConfig {
	const base = resolveDecisions({
		tokenEnv: "PICONTROLS_TEST_TOKEN",
		url: "https://example.invalid/decisions",
	});
	if (!base) throw new Error("resolveDecisions returned null");
	return { ...base, ...overrides } as DecisionsConfig;
}

function answers(
	overrides: Record<string, DecisionsAnswer> = {},
): Record<string, DecisionsAnswer> {
	return {
		destructive: { type: "noul", noul: 0.01 },
		network: { type: "noul", noul: 0.01 },
		exec: { type: "noul", noul: 0.01 },
		inference_call: { type: "noul", noul: 0.01 },
		obfuscated: { type: "noul", noul: 0.01 },
		write_scope: {
			type: "choice",
			choice: "within",
			confidence: 0.95,
			probabilities: { within: 0.95, none: 0.05 },
		},
		read_scope: {
			type: "choice",
			choice: "ordinary",
			confidence: 0.95,
			probabilities: { ordinary: 0.95, none: 0.05 },
		},
		...overrides,
	};
}

function noul(p: number): DecisionsAnswer {
	return { type: "noul", noul: p };
}

function scope(
	choice: string,
	probabilities: Record<string, number>,
): DecisionsAnswer {
	const confidence = probabilities[choice] ?? 0;
	return { type: "choice", choice, confidence, probabilities };
}

describe("bucketAnswers", () => {
	it("buckets noul probabilities at the configured thresholds", () => {
		const config = testConfig();
		const { buckets } = bucketAnswers(
			answers({
				destructive: noul(0.7),
				network: noul(0.69),
				exec: noul(0.3),
				obfuscated: noul(0.31),
			}),
			config,
		);
		expect(buckets.destructive).toBe("yes");
		expect(buckets.network).toBe("uncertain");
		expect(buckets.exec).toBe("no");
		expect(buckets.obfuscated).toBe("uncertain");
	});

	it("requires choice confidence for a label, else uncertain", () => {
		const config = testConfig();
		const confident = bucketAnswers(
			answers({ write_scope: scope("outside", { outside: 0.6, within: 0.4 }) }),
			config,
		);
		expect(confident.buckets.write_scope).toBe("outside");
		const unsure = bucketAnswers(
			answers({
				write_scope: scope("outside", { outside: 0.59, within: 0.41 }),
			}),
			config,
		);
		expect(unsure.buckets.write_scope).toBe("uncertain");
	});

	it("treats benign-label dithering as the top label, not uncertain", () => {
		const config = testConfig();
		const { buckets } = bucketAnswers(
			answers({
				read_scope: scope("ordinary", { ordinary: 0.5, none: 0.4 }),
			}),
			config,
		);
		expect(buckets.read_scope).toBe("ordinary");
	});

	it("rejects missing and mistyped answers", () => {
		const config = testConfig();
		const missing = answers();
		delete missing.network;
		expect(() => bucketAnswers(missing, config)).toThrow(DecisionsError);
		const mistyped = answers({
			destructive: {
				type: "choice",
				choice: "x",
				confidence: 1,
				probabilities: { x: 1 },
			},
		});
		expect(() => bucketAnswers(mistyped, config)).toThrow(DecisionsError);
	});
});

describe("applyStage1", () => {
	const config = testConfig();

	function ruleFor(overrides: Record<string, DecisionsAnswer>) {
		return applyStage1(bucketAnswers(answers(overrides), config).buckets);
	}

	it("denies destructive + out-of-scope writes", () => {
		expect(
			ruleFor({
				destructive: noul(0.95),
				write_scope: scope("outside", { outside: 0.9, within: 0.1 }),
			}),
		).toEqual({ verdict: "deny", rule: "destructive-concealed-or-outside" });
	});

	it("denies destructive + obfuscated even for in-scope writes", () => {
		expect(ruleFor({ destructive: noul(0.95), obfuscated: noul(0.9) })).toEqual(
			{ verdict: "deny", rule: "destructive-concealed-or-outside" },
		);
	});

	it("denies the exfil shape (sensitive read + network)", () => {
		expect(
			ruleFor({
				read_scope: scope("sensitive", { sensitive: 0.9, ordinary: 0.1 }),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "deny", rule: "exfil-shape" });
	});

	it("denies concealed capability (obfuscated + exec)", () => {
		expect(ruleFor({ obfuscated: noul(0.9), exec: noul(0.9) })).toEqual({
			verdict: "deny",
			rule: "concealed-capability",
		});
	});

	it("asks on in-scope destructive code instead of denying", () => {
		expect(ruleFor({ destructive: noul(0.95) })).toEqual({
			verdict: "ask",
			rule: "destructive-in-scope",
		});
	});

	it("asks on out-of-scope and unknown write scopes", () => {
		expect(
			ruleFor({
				write_scope: scope("sensitive_system", { sensitive_system: 0.8 }),
			}),
		).toEqual({ verdict: "ask", rule: "write-out-of-scope" });
		expect(
			ruleFor({ write_scope: scope("unknown", { unknown: 0.8 }) }),
		).toEqual({ verdict: "ask", rule: "write-out-of-scope" });
	});

	it("asks on sensitive reads without network", () => {
		expect(
			ruleFor({
				read_scope: scope("sensitive", { sensitive: 0.9, ordinary: 0.1 }),
			}),
		).toEqual({ verdict: "ask", rule: "sensitive-read" });
	});

	it("asks on lone obfuscation", () => {
		expect(ruleFor({ obfuscated: noul(0.9) })).toEqual({
			verdict: "ask",
			rule: "obfuscated-alone",
		});
	});

	it("asks on uncertain criticals", () => {
		expect(ruleFor({ destructive: noul(0.5) })).toEqual({
			verdict: "ask",
			rule: "uncertain-critical",
		});
	});

	it("does not escalate routine in-scope capabilities", () => {
		expect(ruleFor({ network: noul(0.9), exec: noul(0.9) })).toEqual({
			verdict: null,
			rule: null,
		});
	});

	it("evaluates deny rules before ask rules", () => {
		// destructive=yes alone would ask, but the exfil combo denies.
		expect(
			ruleFor({
				destructive: noul(0.95),
				read_scope: scope("sensitive", { sensitive: 0.9 }),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "deny", rule: "exfil-shape" });
	});
});

describe("scoreBackstop", () => {
	const config = testConfig();

	it("trips on accumulated weak signals", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				network: 0.65,
				exec: 0.6,
				obfuscated: 0.5,
			},
			{ write_scope: { within: 0.9 }, read_scope: { ordinary: 0.9 } },
			config,
		);
		// 5 + 16.25 + 9 + 20 = 50.25
		expect(result.score).toBe(50.25);
		expect(result.threshold).toBe(40);
		expect(result.breached).toBe(true);
		expect(result.contributions).toEqual({
			destructive: 5,
			network: 16.25,
			exec: 9,
			obfuscated: 20,
		});
	});

	it("stays quiet on two uncertain modifiers", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				network: 0.65,
				exec: 0.6,
				obfuscated: 0.05,
			},
			{ write_scope: { within: 0.9 }, read_scope: { ordinary: 0.9 } },
			config,
		);
		// 5 + 16.25 + 9 + 2 = 32.25
		expect(result.score).toBe(32.25);
		expect(result.breached).toBe(false);
	});

	it("counts scope probability tails", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				network: 0.05,
				exec: 0.05,
				obfuscated: 0.05,
			},
			{
				write_scope: { within: 0.6, outside: 0.3, unknown: 0.1 },
				read_scope: { ordinary: 1 },
			},
			config,
		);
		// base 0.05*(100+40+25+15)=9, plus 0.3*30 + 0.1*20 = 11 → 20
		expect(result.score).toBe(20);
		expect(result.breached).toBe(false);
		expect(result.contributions.writeOutside).toBe(9);
		expect(result.contributions.writeUnknown).toBe(2);
	});

	it("honours a configured threshold", () => {
		const strict = testConfig({ backstopThreshold: 10 });
		const result = scoreBackstop(
			{
				destructive: 0.05,
				network: 0.05,
				exec: 0.05,
				obfuscated: 0.05,
			},
			{ write_scope: { within: 1 }, read_scope: { ordinary: 1 } },
			strict,
		);
		expect(result.breached).toBe(false);
		expect(result.threshold).toBe(10);
	});
});

describe("verdictRationale", () => {
	const config = testConfig();

	it("cites the rule and active buckets", () => {
		const { buckets } = bucketAnswers(
			answers({
				read_scope: scope("sensitive", { sensitive: 0.9 }),
				network: noul(0.9),
			}),
			config,
		);
		const rationale = verdictRationale({
			buckets,
			stage1: { verdict: "deny", rule: "exfil-shape" },
			stage2: {
				score: 0,
				threshold: 40,
				breached: false,
				contributions: {},
			},
		});
		expect(rationale).toBe(
			"rule exfil-shape: network=yes, read_scope=sensitive",
		);
	});

	it("cites the score and top contributors for the backstop", () => {
		const { buckets } = bucketAnswers(answers(), config);
		const rationale = verdictRationale({
			buckets,
			stage1: { verdict: null, rule: null },
			stage2: {
				score: 52,
				threshold: 40,
				breached: true,
				contributions: { obfuscated: 20, network: 16.25, exec: 9 },
			},
		});
		expect(rationale).toBe(
			"backstop score 52 ≥ 40: obfuscated 20, network 16.25, exec 9",
		);
	});
});

describe("buildState", () => {
	it("truncates oversized sources and flags it", () => {
		const state = buildState(
			{
				language: "python",
				source: "x".repeat(100),
				interpreter: "python3",
				origin: "inline",
			},
			"python3 -c …",
			"python3 -c …",
			"/home/user/proj",
			[],
			10,
		);
		expect(state.truncated).toBe(true);
		expect(state.source).toBe("x".repeat(10));
		expect(state.execution_context.cwd).toBe("/home/user/proj");
	});
});

describe("classifySource", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.PICONTROLS_TEST_TOKEN = "test-token";
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.PICONTROLS_TEST_TOKEN;
	});

	function okResponse(body: unknown) {
		return new Response(JSON.stringify(body), { status: 200 });
	}

	function verdictBody(overrides: Record<string, DecisionsAnswer> = {}) {
		return {
			id: "gen-test",
			model: "test-model",
			provider: "Test",
			usage: { input_tokens: 10, output_tokens: 5, cost: 0.000001 },
			answers: answers(overrides),
		};
	}

	function classifyInput() {
		return {
			source: {
				language: "python" as const,
				source: "print(1)",
				interpreter: "python3",
				origin: "inline" as const,
			},
			stageCommand: "python3 -c print(1)",
			pipeline: "python3 -c print(1)",
			cwd: "/home/user/proj",
			targets: [] as string[],
		};
	}

	it("returns allow with stage results on a benign answer", async () => {
		globalThis.fetch = (async () =>
			okResponse(verdictBody())) as unknown as typeof fetch;
		const result = await classifySource(classifyInput(), testConfig());
		expect(result.verdict).toBe("allow");
		expect(result.stage1).toEqual({ verdict: null, rule: null });
		expect(result.stage2.breached).toBe(false);
		expect(result.response.usage.cost).toBe(0.000001);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("returns the stage-1 deny verdict on dangerous answers", async () => {
		globalThis.fetch = (async () =>
			okResponse(
				verdictBody({
					destructive: noul(0.95),
					write_scope: scope("outside", { outside: 0.9 }),
				}),
			)) as unknown as typeof fetch;
		const result = await classifySource(classifyInput(), testConfig());
		expect(result.verdict).toBe("deny");
		expect(result.stage1.rule).toBe("destructive-concealed-or-outside");
		// The backstop is still computed for the tuning log.
		expect(result.stage2.score).toBeGreaterThan(0);
	});

	it("maps HTTP auth failures to auth errors", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(DecisionsError);
		expect((error as DecisionsError).code).toBe("auth");
	});

	it("maps HTTP errors to http errors", async () => {
		globalThis.fetch = (async () =>
			new Response("busy", { status: 503 })) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("http");
	});

	it("maps aborts to timeout errors", async () => {
		globalThis.fetch = (() =>
			Promise.reject(
				new DOMException("signal timed out", "TimeoutError"),
			)) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("timeout");
		expect((error as DecisionsError).detail).toContain("timeout after");
	});

	it("maps network failures to network errors", async () => {
		globalThis.fetch = (() =>
			Promise.reject(new Error("boom"))) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("network");
	});

	it("maps malformed responses to malformed errors", async () => {
		globalThis.fetch = (async () =>
			okResponse({ nope: true })) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("malformed");
	});

	it("requires the auth token env var", async () => {
		delete process.env.PICONTROLS_TEST_TOKEN;
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return okResponse(verdictBody());
		}) as unknown as typeof fetch;
		const error = await classifySource(classifyInput(), testConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("auth");
		expect(called).toBe(false);
	});
});

describe("eval verdict cache", () => {
	beforeEach(() => clearEvalCache());
	afterEach(() => clearEvalCache());

	it("keys deterministically on language + source", () => {
		expect(evalCacheKey("python", "x")).toBe(evalCacheKey("python", "x"));
		expect(evalCacheKey("python", "x")).not.toBe(evalCacheKey("node", "x"));
		expect(evalCacheKey("python", "x")).not.toBe(evalCacheKey("python", "y"));
	});

	it("stores and returns verdicts", () => {
		expect(getCachedVerdict("k")).toBeUndefined();
		setCachedVerdict("k", "ask");
		expect(getCachedVerdict("k")).toBe("ask");
	});

	it("evicts the oldest entry past the cap", () => {
		for (let i = 0; i < 200; i++) setCachedVerdict(`k${i}`, "allow");
		setCachedVerdict("fresh", "deny");
		expect(getCachedVerdict("k0")).toBeUndefined();
		expect(getCachedVerdict("k1")).toBe("allow");
		expect(getCachedVerdict("fresh")).toBe("deny");
	});
});

it("honours a configured threshold", () => {
	const strict = testConfig({ backstopThreshold: 10 });
	const result = scoreBackstop(
		{
			destructive: 0.05,
			network: 0.05,
			exec: 0.05,
			obfuscated: 0.05,
		},
		{ write_scope: { within: 1 }, read_scope: { ordinary: 1 } },
		strict,
	);
	expect(result.breached).toBe(false);
	expect(result.threshold).toBe(10);
});

describe("inference_call", () => {
	const config = testConfig();

	it("asks on token-spending model inference via its own rule", () => {
		const { buckets } = bucketAnswers(
			answers({ inference_call: noul(0.9) }),
			config,
		);
		expect(applyStage1(buckets)).toEqual({
			verdict: "ask",
			rule: "inference-call",
		});
	});

	it("stays quiet when no inference call is visible", () => {
		const { buckets } = bucketAnswers(
			answers({ inference_call: noul(0.5) }),
			config,
		);
		expect(applyStage1(buckets)).toEqual({ verdict: null, rule: null });
	});

	it("contributes to the backstop score", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				network: 0.05,
				exec: 0.05,
				inference_call: 0.9,
				obfuscated: 0.05,
			},
			{ write_scope: { within: 1 }, read_scope: { ordinary: 1 } },
			config,
		);
		expect(result.contributions.inferenceCall).toBe(9);
	});
});
