/**
 * Human-readable explanation for an `auto` verdict.
 *
 * The prompt title (ask) or block reason (deny) is the only place the user
 * sees why the call was stopped, so it has to carry the whole story: which rule
 * fired, how sure the classifier was, what it did *not* find, and which paths
 * it looked at. A bare rule label leaves the user no way to judge the request.
 */

import type { AutoTarget } from "./auto-state.js";
import type { AutoBuckets, AutoProbabilities } from "./auto-decisions.js";
import type { BackstopResult, Stage1Result } from "./decisions.js";
import type { ScopeSource } from "./scope.js";

/** Keep prompts readable; the explanation is embedded in a one-line title. */
export const MAX_EXPLANATION = 320;

export interface ExplainInput {
	buckets: AutoBuckets;
	probabilities: AutoProbabilities;
	scopeSource: ScopeSource;
	stage1: Stage1Result;
	stage2: BackstopResult;
}

function fmtProbabilities(probabilities: Record<string, number>): string {
	return Object.entries(probabilities)
		.filter(([, value]) => value > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([label, value]) => `${label} ${value.toFixed(2)}`)
		.join(", ");
}

function fmtTargets(targets: readonly AutoTarget[], limit = 3): string {
	if (targets.length === 0) return "none";
	const shown = targets
		.slice(0, limit)
		.map((target) => `${target.path} (${target.scope})`)
		.join(", ");
	const rest = targets.length - limit;
	return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/** Dimensions whose bucket stayed undecided — the "why is this unclear" answer. */
function unclearDimensions(
	buckets: AutoBuckets,
	probs: AutoProbabilities,
): string[] {
	const out: string[] = [];
	if (buckets.destructive === "uncertain") {
		out.push(`destructive (${probs.destructive.toFixed(2)})`);
	}
	if (buckets.concealed === "uncertain") {
		out.push(`concealed (${probs.concealed.toFixed(2)})`);
	}
	if (buckets.data_sensitivity === "uncertain") {
		out.push(`data_sensitivity (${fmtProbabilities(probs.data_sensitivity)})`);
	}
	if (buckets.scope === "uncertain" || buckets.scope === "unknown") {
		out.push(`scope (${fmtProbabilities(probs.scope)})`);
	}
	if (
		buckets.action_class === "uncertain" ||
		buckets.action_class === "unknown"
	) {
		out.push(`action_class (${buckets.action_class})`);
	}
	return out;
}

type TailDimension =
	| "destructive"
	| "network"
	| "concealed"
	| "data_sensitivity";

/** Bucketed dimensions reported after the decisive clause, minus those already named. */
const TAIL_DIMENSIONS: readonly TailDimension[] = [
	"destructive",
	"network",
	"concealed",
	"data_sensitivity",
];

/** The clause naming what fired, plus the dimensions it already reported. */
function decisiveSignals(
	buckets: AutoBuckets,
	probs: AutoProbabilities,
	rule: string,
): { text: string; named: TailDimension[] } {
	switch (rule) {
		case "sensitive-read":
			return {
				text: `data_sensitivity=${buckets.data_sensitivity} (${fmtProbabilities(probs.data_sensitivity)})`,
				named: ["data_sensitivity"],
			};
		case "write-out-of-scope":
			return { text: `action_class=${buckets.action_class}`, named: [] };
		case "destructive":
			return {
				text: `destructive=${buckets.destructive} (${probs.destructive.toFixed(2)})`,
				named: ["destructive"],
			};
		case "destructive-out-of-scope":
		case "destructive-concealed":
			return {
				text: `destructive=${buckets.destructive} (${probs.destructive.toFixed(2)}), concealed=${buckets.concealed}`,
				named: ["destructive", "concealed"],
			};
		case "exfil-shape":
			return {
				text: `data_sensitivity=${buckets.data_sensitivity}, network=${buckets.network}, action_class=${buckets.action_class}`,
				named: ["data_sensitivity", "network"],
			};
		case "concealed-capability":
		case "concealed-alone":
			return {
				text: `concealed=${buckets.concealed} (${probs.concealed.toFixed(2)}), action_class=${buckets.action_class}, network=${buckets.network}`,
				named: ["concealed", "network"],
			};
		case "inference-call":
			return {
				text: `inference_call=${buckets.inference_call} (${probs.inference_call.toFixed(2)})`,
				named: [],
			};
		case "uncertain-critical": {
			const unclear = unclearDimensions(buckets, probs);
			return {
				text:
					unclear.length > 0
						? `classifier undecided on ${unclear.join(", ")}`
						: "classifier undecided on a critical dimension",
				named: [...TAIL_DIMENSIONS].filter(
					(name) => buckets[name] === "uncertain",
				),
			};
		}
		default:
			return { text: "", named: [] };
	}
}

const SCOPE_SOURCE_LABEL: Record<ScopeSource, string> = {
	deterministic: "from paths",
	fallback: "no paths",
	model: "model",
};

/**
 * One line explaining the verdict: what fired, what the classifier saw, what it
 * settled, and which paths were involved.
 */
export function describeAutoVerdict(
	result: ExplainInput,
	targets: readonly AutoTarget[],
): string {
	const { buckets, probabilities, stage1, stage2 } = result;
	const parts: string[] = [];
	const named: TailDimension[] = [];

	if (stage1.rule) {
		const signals = decisiveSignals(buckets, probabilities, stage1.rule);
		parts.push(
			signals.text
				? `rule ${stage1.rule}: ${signals.text}`
				: `rule ${stage1.rule}`,
		);
		named.push(...signals.named);
	} else {
		const contributions = Object.entries(stage2.contributions)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([name, value]) => `${name} ${value}`)
			.join(" + ");
		const comparison = stage2.breached ? "≥" : "<";
		parts.push(
			`backstop score ${stage2.score} ${comparison} ${stage2.threshold}` +
				(contributions ? ` (${contributions})` : ""),
		);
	}

	const settled = TAIL_DIMENSIONS.filter((name) => !named.includes(name)).map(
		(name) => `${name}=${buckets[name]}`,
	);
	if (settled.length > 0) parts.push(`other signals: ${settled.join(", ")}`);
	parts.push(
		`scope=${buckets.scope} (${SCOPE_SOURCE_LABEL[result.scopeSource]})`,
	);
	parts.push(`targets: ${fmtTargets(targets)}`);

	const detail = parts.join("; ");
	return detail.length > MAX_EXPLANATION
		? `${detail.slice(0, MAX_EXPLANATION - 1)}…`
		: detail;
}
