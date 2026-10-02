/**
 * Jev question builders (REQUIREMENTS R7.3, R7.4).
 *
 * Exact strings from the experiment: the few-shot instructions end with a
 * newline and the exemplar lines are appended directly; the zero-shot
 * instructions are the bare sentence.
 */

import type { Tier } from "../bundle.js";

export const TIER_CRITERIA: Record<Tier, string> = {
	economy:
		"Fully specified or tightly scoped work: read-only audits, delegated subagent tasks, lookups, routine operations.",
	standard:
		"Ordinary interactive engineering: bounded changes, explanations, everyday debugging.",
	high: "Ambiguous work with clear success criteria: subtle debugging, correctness-sensitive integration, iterating on rejected work.",
	premium:
		"Open-ended work: trade-off discussion, comparison, recommendation, design, creativity.",
};

export const FEWSHOT_INSTRUCTIONS =
	"Choose the model tier the user would want for the work remaining in the latest request. " +
	"Below are past requests from the same user that resemble this one, each with the tier the " +
	"user chose. Match the user's preferences; similar requests should get similar tiers.\n";

export const ZEROSHOT_INSTRUCTIONS =
	"Choose the model tier the user would want for the work remaining in the latest request.";

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

/** Few-shot question (`jev-all`, `jev-k24`): instructions + exemplar lines. */
export function fewShotQuestion(exemplarLines: string): ChoiceQuestion {
	return {
		type: "choice",
		instructions: `${FEWSHOT_INSTRUCTIONS}${exemplarLines}`,
		criteria: { ...TIER_CRITERIA },
	};
}

/** Zero-shot question (`jev-zeroshot`): the same criteria, no examples. */
export function zeroShotQuestion(): ChoiceQuestion {
	return {
		type: "choice",
		instructions: ZEROSHOT_INSTRUCTIONS,
		criteria: { ...TIER_CRITERIA },
	};
}
