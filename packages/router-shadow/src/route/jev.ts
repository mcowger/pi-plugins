/**
 * Jev decisions call (REQUIREMENTS R7.1, R7.2, R7.7).
 */

import { TIER_RANK, type Tier, isTier } from "../bundle.js";
import type { BoundedState } from "../context/bounded.js";
import type { PostJson } from "../http.js";
import { fewShotQuestion, zeroShotQuestion } from "./questions.js";

export const JEV_TIMEOUT_MS = 3000;

export interface JevRequestBody {
	model: string;
	state: BoundedState;
	questions: { tier: ReturnType<typeof fewShotQuestion> };
}

export interface JevOutcome {
	tier: Tier;
	probs: Record<Tier, number> | null;
	tier_expected: number | null;
	confidence: number | null;
	input_tokens: number | null;
	cost: number | null;
}

/** Build the exact request body for a few-shot candidate. */
export function jevRequestBody(
	jevModel: string,
	state: BoundedState,
	exemplarLines: string,
): JevRequestBody {
	return {
		model: jevModel,
		state,
		questions: { tier: fewShotQuestion(exemplarLines) },
	};
}

/** Build the exact request body for the zero-shot candidate. */
export function jevZeroShotRequestBody(
	jevModel: string,
	state: BoundedState,
): JevRequestBody {
	return {
		model: jevModel,
		state,
		questions: { tier: zeroShotQuestion() },
	};
}

function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a Jev response (mirrors `fixtures/jev.json → expected_parse`).
 * Throws `invalid_answer` unless `answers.tier.choice` is a known tier.
 */
export function parseJevResponse(json: unknown): JevOutcome {
	if (json === null || typeof json !== "object" || Array.isArray(json)) {
		throw new Error("invalid_answer: missing answers.tier");
	}
	const root = json as Record<string, unknown>;
	const answers =
		root.answers !== null && typeof root.answers === "object"
			? (root.answers as Record<string, unknown>)
			: null;
	const tierAnswer =
		answers?.tier !== null && typeof answers?.tier === "object"
			? (answers.tier as Record<string, unknown>)
			: null;
	const choice = tierAnswer?.choice;
	if (!isTier(choice)) {
		throw new Error("invalid_answer: answers.tier.choice is not a tier");
	}
	let probs: Record<Tier, number> | null = null;
	let tierExpected: number | null = null;
	const rawProbs = tierAnswer?.probabilities;
	if (rawProbs !== null && typeof rawProbs === "object") {
		probs = {} as Record<Tier, number>;
		let sum = 0;
		for (const [key, value] of Object.entries(rawProbs)) {
			if (!isTier(key)) {
				throw new Error(`invalid_answer: unknown tier ${key} in probabilities`);
			}
			const probability = asFiniteNumber(value);
			if (probability === null) {
				throw new Error(`invalid_answer: non-numeric probability for ${key}`);
			}
			probs[key] = probability;
			sum += TIER_RANK[key] * probability;
		}
		tierExpected = round6(sum);
	}
	const usage =
		root.usage !== null && typeof root.usage === "object"
			? (root.usage as Record<string, unknown>)
			: null;
	return {
		tier: choice,
		probs,
		tier_expected: tierExpected,
		confidence: asFiniteNumber(tierAnswer?.confidence),
		input_tokens: asFiniteNumber(usage?.input_tokens),
		cost: asFiniteNumber(usage?.cost),
	};
}

export async function callJev(
	post: PostJson,
	args: {
		body: JevRequestBody;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<JevOutcome> {
	const { json } = await post("/v1/decisions", args.body, {
		timeoutMs: args.timeoutMs ?? JEV_TIMEOUT_MS,
		abort: args.signal,
	});
	try {
		return parseJevResponse(json);
	} catch (err) {
		throw new Error((err as Error).message);
	}
}
