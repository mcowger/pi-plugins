import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveAuto, resolveDecisions } from "../../src/config.js";
import {
	DecisionsError,
	type DecisionsAnswer,
} from "../../src/utils/decisions.js";
import {
	AUTO_ACTION_CLASS_QUESTION,
	AUTO_CONCEALED_QUESTION,
	AUTO_DATA_SENSITIVITY_QUESTION,
	AUTO_SCOPE_QUESTION,
	applyStage1,
	autoCacheKey,
	bucketAnswers,
	buildQuestions,
	classifyAuto,
	clearAutoCache,
	getCachedAutoVerdict,
	scoreBackstop,
	setCachedAutoVerdict,
	type AutoClassifyInput,
} from "../../src/utils/auto-decisions.js";
import type { AutoState } from "../../src/utils/auto-state.js";
import type { AutoConfig, DecisionsConfig } from "../../src/config.js";

function testConfig(overrides: Record<string, unknown> = {}): AutoConfig {
	return { ...resolveAuto({}), ...overrides } as AutoConfig;
}

function noul(p: number): DecisionsAnswer {
	return { type: "noul", noul: p };
}

function choice(
	label: string,
	probabilities: Record<string, number>,
): DecisionsAnswer {
	return {
		type: "choice",
		choice: label,
		confidence: probabilities[label] ?? 0,
		probabilities,
	};
}

function answers(
	overrides: Record<string, DecisionsAnswer> = {},
): Record<string, DecisionsAnswer> {
	return {
		[AUTO_ACTION_CLASS_QUESTION]: choice("local_read", {
			local_read: 0.95,
			none: 0.05,
		}),
		[AUTO_SCOPE_QUESTION]: choice("within", { within: 0.95, outside: 0.05 }),
		[AUTO_DATA_SENSITIVITY_QUESTION]: choice("ordinary", {
			ordinary: 0.95,
			none: 0.05,
		}),
		destructive: noul(0.01),
		network: noul(0.01),
		concealed: noul(0.01),
		inference_call: noul(0.01),
		...overrides,
	};
}

function state(): AutoState {
	return {
		tool: "bash",
		input: { command: "ls", command_truncated: false },
		cwd: "/home/user/proj",
		targets: [{ path: "/home/user/proj", scope: "within" }],
		conversation: [],
		scope_note: "scope",
	};
}

function decisionsConfig(auto: Record<string, unknown> = {}): DecisionsConfig {
	const resolved = resolveDecisions({
		tokenEnv: "PICONTROLS_TEST_TOKEN",
		url: "https://example.invalid/decisions",
		auto,
	});
	if (!resolved) throw new Error("resolveDecisions returned null");
	return resolved;
}

// ─── Buckets ──────────────────────────────────────────────────────────────────

describe("bucketAnswers", () => {
	it("buckets noul probabilities at the configured thresholds", () => {
		const { buckets } = bucketAnswers(
			answers({
				destructive: noul(0.7),
				network: noul(0.69),
				concealed: noul(0.3),
				inference_call: noul(0.31),
			}),
			testConfig(),
		);
		expect(buckets.destructive).toBe("yes");
		expect(buckets.network).toBe("uncertain");
		expect(buckets.concealed).toBe("no");
		expect(buckets.inference_call).toBe("uncertain");
	});

	it("requires choice confidence for a label, else uncertain", () => {
		const config = testConfig();
		const confident = bucketAnswers(
			answers({
				[AUTO_SCOPE_QUESTION]: choice("outside", {
					outside: 0.6,
					within: 0.4,
				}),
			}),
			config,
		);
		expect(confident.buckets.scope).toBe("outside");
		const unsure = bucketAnswers(
			answers({
				[AUTO_SCOPE_QUESTION]: choice("within", {
					within: 0.55,
					outside: 0.4,
				}),
			}),
			config,
		);
		expect(unsure.buckets.scope).toBe("uncertain");
	});

	it("treats benign-label dithering as the top label, not uncertain", () => {
		const { buckets } = bucketAnswers(
			answers({
				[AUTO_SCOPE_QUESTION]: choice("within", {
					within: 0.5,
					not_applicable: 0.4,
				}),
			}),
			testConfig(),
		);
		expect(buckets.scope).toBe("within");
	});

	it("falls back to the top label when probabilities are absent", () => {
		const { buckets } = bucketAnswers(
			answers({
				[AUTO_SCOPE_QUESTION]: {
					type: "choice",
					choice: "within",
					confidence: 0.9,
				} as DecisionsAnswer,
			}),
			testConfig(),
		);
		expect(buckets.scope).toBe("within");
	});

	it("rejects an out-of-schema choice label", () => {
		expect(() =>
			bucketAnswers(
				answers({
					[AUTO_SCOPE_QUESTION]: choice("Outside", { Outside: 0.9 }),
				}),
				testConfig(),
				{
					action_class: new Set(["local_read"]),
					scope: new Set(["within", "outside", "unknown"]),
					data_sensitivity: new Set(["ordinary"]),
				},
			),
		).toThrow(DecisionsError);
	});

	it("falls back to a point mass on the chosen label for the backstop", () => {
		const { probs } = bucketAnswers(
			answers({
				[AUTO_DATA_SENSITIVITY_QUESTION]: {
					type: "choice",
					choice: "sensitive",
					confidence: 0.9,
				} as DecisionsAnswer,
			}),
			testConfig(),
		);
		expect(probs.data_sensitivity).toEqual({ sensitive: 1 });
	});

	it("uses per-question thresholds over the globals", () => {
		const config = resolveAuto({
			thresholds: {
				destructive: { yes: 0.5 },
				scope: { confidence: 0.9 },
			},
		});
		const { buckets } = bucketAnswers(
			answers({
				destructive: noul(0.55),
				network: noul(0.55),
				[AUTO_SCOPE_QUESTION]: choice("outside", {
					outside: 0.8,
					within: 0.2,
				}),
			}),
			config,
		);
		expect(buckets.destructive).toBe("yes");
		expect(buckets.network).toBe("uncertain");
		expect(buckets.scope).toBe("uncertain");
	});

	it("overrides the model's scope with a deterministic one", () => {
		const result = bucketAnswers(
			answers({
				[AUTO_SCOPE_QUESTION]: choice("outside", {
					outside: 0.9,
					within: 0.1,
				}),
			}),
			testConfig(),
			undefined,
			{ kind: "paths", scope: "within" },
		);
		expect(result.buckets.scope).toBe("within");
		expect(result.probs.scope).toEqual({ within: 1 });
		expect(result.scopeSource).toBe("deterministic");
	});

	it("collapses an unknown scope to not_applicable when the call names no paths", () => {
		const unknown = answers({
			[AUTO_SCOPE_QUESTION]: choice("unknown", { unknown: 0.9 }),
		});
		const none = bucketAnswers(unknown, testConfig(), undefined, {
			kind: "none",
		});
		expect(none.buckets.scope).toBe("not_applicable");
		expect(none.scopeSource).toBe("fallback");
		// Unresolvable paths leave the model's answer in place.
		const model = bucketAnswers(unknown, testConfig());
		expect(model.buckets.scope).toBe("unknown");
		expect(model.probs.scope).toEqual({ unknown: 0.9 });
		expect(model.scopeSource).toBe("model");
	});

	it("rejects missing and mistyped answers", () => {
		const config = testConfig();
		const missing = answers();
		delete missing.network;
		expect(() => bucketAnswers(missing, config)).toThrow(DecisionsError);
		const mistyped = answers({ destructive: choice("x", { x: 1 }) });
		expect(() => bucketAnswers(mistyped, config)).toThrow(DecisionsError);
	});
});

// ─── Stage 1 ──────────────────────────────────────────────────────────────────

describe("applyStage1", () => {
	const config = testConfig();

	function ruleFor(overrides: Record<string, DecisionsAnswer>) {
		return applyStage1(bucketAnswers(answers(overrides), config).buckets);
	}

	it("denies destructive out-of-scope calls", () => {
		expect(
			ruleFor({
				destructive: noul(0.95),
				[AUTO_SCOPE_QUESTION]: choice("outside", { outside: 0.9 }),
			}),
		).toEqual({ verdict: "deny", rule: "destructive-out-of-scope" });
	});

	it("denies destructive + concealed calls", () => {
		expect(ruleFor({ destructive: noul(0.95), concealed: noul(0.9) })).toEqual({
			verdict: "deny",
			rule: "destructive-concealed",
		});
	});

	it("denies the exfil shape (sensitive data + network + remote write)", () => {
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
				[AUTO_ACTION_CLASS_QUESTION]: choice("remote_write", {
					remote_write: 0.9,
				}),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "deny", rule: "exfil-shape" });
	});

	it("asks rather than denies when sensitive data and network lack a transmit action", () => {
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "ask", rule: "sensitive-read" });
		// process_exec alone is not a transmit action…
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
				[AUTO_ACTION_CLASS_QUESTION]: choice("process_exec", {
					process_exec: 0.9,
				}),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "ask", rule: "sensitive-read" });
		// …unless it also reaches a credential store or system location.
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
				[AUTO_ACTION_CLASS_QUESTION]: choice("process_exec", {
					process_exec: 0.9,
				}),
				[AUTO_SCOPE_QUESTION]: choice("sensitive_system", {
					sensitive_system: 0.9,
				}),
				network: noul(0.9),
			}),
		).toEqual({ verdict: "deny", rule: "exfil-shape" });
	});

	it("denies concealed capability via process exec or network", () => {
		expect(
			ruleFor({
				concealed: noul(0.9),
				[AUTO_ACTION_CLASS_QUESTION]: choice("process_exec", {
					process_exec: 0.9,
				}),
			}),
		).toEqual({ verdict: "deny", rule: "concealed-capability" });
		expect(ruleFor({ concealed: noul(0.9), network: noul(0.9) })).toEqual({
			verdict: "deny",
			rule: "concealed-capability",
		});
	});

	it("evaluates deny rules before ask rules", () => {
		expect(
			ruleFor({
				destructive: noul(0.95),
				network: noul(0.9),
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
				[AUTO_ACTION_CLASS_QUESTION]: choice("remote_write", {
					remote_write: 0.9,
				}),
			}),
		).toEqual({ verdict: "deny", rule: "exfil-shape" });
	});

	it("asks on in-scope destructive calls instead of denying", () => {
		expect(ruleFor({ destructive: noul(0.95) })).toEqual({
			verdict: "ask",
			rule: "destructive",
		});
	});

	it("asks on out-of-scope and unknown writes", () => {
		expect(
			ruleFor({
				[AUTO_ACTION_CLASS_QUESTION]: choice("local_write", {
					local_write: 0.9,
				}),
				[AUTO_SCOPE_QUESTION]: choice("sensitive_system", {
					sensitive_system: 0.9,
				}),
			}),
		).toEqual({ verdict: "ask", rule: "write-out-of-scope" });
		expect(
			ruleFor({
				[AUTO_ACTION_CLASS_QUESTION]: choice("local_write", {
					local_write: 0.9,
				}),
				[AUTO_SCOPE_QUESTION]: choice("unknown", { unknown: 0.9 }),
			}),
		).toEqual({ verdict: "ask", rule: "write-out-of-scope" });
	});

	it("asks on sensitive or unknown data reads", () => {
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("sensitive", {
					sensitive: 0.9,
				}),
			}),
		).toEqual({ verdict: "ask", rule: "sensitive-read" });
		expect(
			ruleFor({
				[AUTO_DATA_SENSITIVITY_QUESTION]: choice("unknown", { unknown: 0.9 }),
			}),
		).toEqual({ verdict: "ask", rule: "sensitive-read" });
	});

	it("asks on lone concealment and inference calls", () => {
		expect(ruleFor({ concealed: noul(0.9) })).toEqual({
			verdict: "ask",
			rule: "concealed-alone",
		});
		expect(ruleFor({ inference_call: noul(0.9) })).toEqual({
			verdict: "ask",
			rule: "inference-call",
		});
	});

	it("asks on uncertain criticals and unknown action classes", () => {
		expect(ruleFor({ destructive: noul(0.5) })).toEqual({
			verdict: "ask",
			rule: "uncertain-critical",
		});
		expect(
			ruleFor({
				[AUTO_ACTION_CLASS_QUESTION]: choice("unknown", { unknown: 0.9 }),
			}),
		).toEqual({ verdict: "ask", rule: "uncertain-critical" });
	});

	it("asks on unknown scope regardless of action class", () => {
		expect(
			ruleFor({
				[AUTO_SCOPE_QUESTION]: choice("unknown", { unknown: 0.9 }),
				[AUTO_ACTION_CLASS_QUESTION]: choice("process_exec", {
					process_exec: 0.9,
				}),
			}),
		).toEqual({ verdict: "ask", rule: "uncertain-critical" });
	});

	it("treats temporary scope as benign for destructive cleanup", () => {
		expect(
			ruleFor({
				destructive: noul(0.95),
				[AUTO_SCOPE_QUESTION]: choice("temporary", { temporary: 0.9 }),
			}),
		).toEqual({ verdict: "ask", rule: "destructive" });
	});

	it("does not escalate routine in-scope capabilities", () => {
		expect(
			ruleFor({
				network: noul(0.9),
				[AUTO_ACTION_CLASS_QUESTION]: choice("process_exec", {
					process_exec: 0.9,
				}),
			}),
		).toEqual({ verdict: null, rule: null });
		expect(
			ruleFor({
				[AUTO_ACTION_CLASS_QUESTION]: choice("remote_write", {
					remote_write: 0.9,
				}),
			}),
		).toEqual({ verdict: null, rule: null });
	});

	it("caps at ask when deny is disabled", () => {
		const buckets = bucketAnswers(
			answers({
				destructive: noul(0.95),
				[AUTO_SCOPE_QUESTION]: choice("outside", { outside: 0.9 }),
			}),
			config,
		).buckets;
		expect(applyStage1(buckets, false)).toEqual({
			verdict: "ask",
			rule: "destructive",
		});
	});
});

// ─── Stage 2 ──────────────────────────────────────────────────────────────────

describe("scoreBackstop", () => {
	const config = testConfig();

	it("sums weighted signals and their contributions", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				concealed: 0.05,
				network: 0.05,
				inference_call: 0.05,
				scope: { within: 1 },
				data_sensitivity: { ordinary: 1 },
			},
			config,
		);
		expect(result.score).toBe(8.5);
		expect(result.threshold).toBe(40);
		expect(result.breached).toBe(false);
		expect(result.contributions).toEqual({
			destructive: 5,
			concealed: 2,
			network: 1,
			inferenceCall: 0.5,
		});
	});

	it("trips on accumulated scope risk", () => {
		const result = scoreBackstop(
			{
				destructive: 0.05,
				concealed: 0.05,
				network: 0.05,
				inference_call: 0.05,
				scope: { within: 0.4, outside: 0.6 },
				data_sensitivity: { ordinary: 1 },
			},
			config,
		);
		// base 8.5 + 0.6*30 = 26.5
		expect(result.score).toBe(26.5);
		expect(result.contributions.scopeRisky).toBe(18);
	});

	it("counts sensitive data mass", () => {
		const result = scoreBackstop(
			{
				destructive: 0.01,
				concealed: 0.01,
				network: 0.01,
				inference_call: 0.01,
				scope: { within: 1 },
				data_sensitivity: { ordinary: 0.5, sensitive: 0.5 },
			},
			config,
		);
		// 1 + 0.4 + 0.2 + 0.1 + 25 = 26.7
		expect(result.contributions.sensitiveData).toBe(25);
		expect(result.breached).toBe(false);
	});

	it("honours a configured threshold", () => {
		const strict = testConfig({ backstopThreshold: 5 });
		const result = scoreBackstop(
			{
				destructive: 0.05,
				concealed: 0.05,
				network: 0.05,
				inference_call: 0.05,
				scope: { within: 1 },
				data_sensitivity: { ordinary: 1 },
			},
			strict,
		);
		expect(result.breached).toBe(true);
		expect(result.threshold).toBe(5);
	});
});

// ─── Rationale and questions ──────────────────────────────────────────────────

describe("buildQuestions", () => {
	it("ships the seven universal questions", () => {
		const questions = buildQuestions();
		expect(Object.keys(questions).sort()).toEqual(
			[
				"action_class",
				"concealed",
				"data_sensitivity",
				"destructive",
				"inference_call",
				"network",
				"scope",
			].sort(),
		);
	});

	it("merges per-question overrides over defaults", () => {
		const questions = buildQuestions({
			[AUTO_ACTION_CLASS_QUESTION]: {
				instructions: "custom instructions",
				criteria: { local_write: "custom write" },
			},
		});
		const actionClass = questions[AUTO_ACTION_CLASS_QUESTION];
		expect(actionClass.instructions).toBe("custom instructions");
		if (actionClass.type !== "choice") throw new Error("expected choice");
		expect(actionClass.criteria.local_write).toBe("custom write");
		expect(actionClass.criteria.local_read).toBeDefined();
		expect(actionClass.criteria.local_read).not.toBe("custom write");
	});
});

// ─── Client ───────────────────────────────────────────────────────────────────

describe("classifyAuto", () => {
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

	function input(): AutoClassifyInput {
		return { state: state(), sessionId: "session-1" };
	}

	it("returns allow on a benign answer", async () => {
		globalThis.fetch = (async () =>
			okResponse(verdictBody())) as unknown as typeof fetch;
		const result = await classifyAuto(input(), decisionsConfig());
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
					[AUTO_SCOPE_QUESTION]: choice("outside", { outside: 0.9 }),
				}),
			)) as unknown as typeof fetch;
		const result = await classifyAuto(input(), decisionsConfig());
		expect(result.verdict).toBe("deny");
		expect(result.stage1.rule).toBe("destructive-out-of-scope");
		expect(result.stage2.score).toBeGreaterThan(0);
	});

	it("caps at ask when deny is disabled", async () => {
		globalThis.fetch = (async () =>
			okResponse(
				verdictBody({
					destructive: noul(0.95),
					[AUTO_SCOPE_QUESTION]: choice("outside", { outside: 0.9 }),
				}),
			)) as unknown as typeof fetch;
		const result = await classifyAuto(
			input(),
			decisionsConfig({ deny: false }),
		);
		expect(result.verdict).toBe("ask");
		expect(result.stage1.rule).toBe("destructive");
	});

	it("sends the session id and applies question overrides", async () => {
		let sent: { session_id?: string; questions?: Record<string, unknown> } = {};
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body));
			return okResponse(verdictBody());
		}) as unknown as typeof fetch;
		await classifyAuto(
			input(),
			decisionsConfig({
				questions: {
					[AUTO_ACTION_CLASS_QUESTION]: { instructions: "custom" },
				},
			}),
		);
		expect(sent.session_id).toBe("session-1");
		const actionClass = sent.questions?.[AUTO_ACTION_CLASS_QUESTION] as {
			instructions: string;
		};
		expect(actionClass.instructions).toBe("custom");
	});

	it("maps HTTP auth failures to auth errors", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const error = await classifyAuto(input(), decisionsConfig()).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(DecisionsError);
		expect((error as DecisionsError).code).toBe("auth");
	});

	it("maps malformed responses to malformed errors", async () => {
		globalThis.fetch = (async () =>
			okResponse({ nope: true })) as unknown as typeof fetch;
		const error = await classifyAuto(input(), decisionsConfig()).catch(
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
		const error = await classifyAuto(input(), decisionsConfig()).catch(
			(e) => e,
		);
		expect((error as DecisionsError).code).toBe("auth");
		expect(called).toBe(false);
	});
});

// ─── Cache ────────────────────────────────────────────────────────────────────

describe("auto verdict cache", () => {
	beforeEach(() => clearAutoCache());
	afterEach(() => clearAutoCache());

	it("keys on tool, raw input, sorted targets, cwd, and session", () => {
		const base = {
			tool: "bash",
			rawInput: { command: "git status" },
			targets: ["/home/user/proj", "/tmp"],
			cwd: "/home/user/proj",
			sessionId: "s1",
		};
		expect(autoCacheKey(base)).toBe(autoCacheKey({ ...base }));
		expect(autoCacheKey(base)).toBe(
			autoCacheKey({ ...base, targets: [...base.targets].reverse() }),
		);
		expect(autoCacheKey(base)).not.toBe(
			autoCacheKey({ ...base, cwd: "/other" }),
		);
		expect(autoCacheKey(base)).not.toBe(
			autoCacheKey({ ...base, sessionId: "s2" }),
		);
		expect(autoCacheKey(base)).not.toBe(
			autoCacheKey({ ...base, rawInput: { command: "rm -rf /" } }),
		);
	});

	it("distinguishes raw inputs that normalize to the same state", () => {
		// Both truncate to the same 10-byte command preview, then differ.
		const base = {
			tool: "bash",
			targets: ["/tmp"],
			cwd: "/tmp",
			sessionId: "s1",
		};
		const a = autoCacheKey({
			...base,
			rawInput: { command: "echo AAAAAAAAAAA" },
		});
		const b = autoCacheKey({
			...base,
			rawInput: { command: "echo AAAAAAAAAAB" },
		});
		expect(a).not.toBe(b);
	});

	it("stores, returns, and evicts verdicts with their explanation", () => {
		expect(getCachedAutoVerdict("k")).toBeUndefined();
		setCachedAutoVerdict("k", { verdict: "ask", explanation: "why" });
		expect(getCachedAutoVerdict("k")).toEqual({
			verdict: "ask",
			explanation: "why",
		});
		for (let i = 0; i < 200; i++) {
			setCachedAutoVerdict(`k${i}`, { verdict: "allow", explanation: "" });
		}
		setCachedAutoVerdict("fresh", { verdict: "deny", explanation: "" });
		expect(getCachedAutoVerdict("k0")).toBeUndefined();
		expect(getCachedAutoVerdict("fresh")?.verdict).toBe("deny");
	});
});
