import {
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ResolvedInvocation } from "./invocation.js";

/** The subset of `ModelRegistry` admission needs; lets tests pass a fake. */
export interface ModelLookup {
	find(provider: string, modelId: string): Model<any> | undefined;
	hasConfiguredAuth(model: Model<any>): boolean;
	getAll?(): Model<any>[];
	getAvailable?(): Model<any>[];
}

export interface ResolvedChildModel {
	model: Model<any>;
	/** Validated thinking level, or undefined when nothing pins one. */
	thinking?: ModelThinkingLevel;
}

/**
 * Global Pi default model, resolved independently of the parent composer.
 *
 * R2.4: a newly spawned child does not inherit the parent's live model choice.
 * The definition or caller may still pin one; otherwise the child uses the
 * configured global default, and `createAgentSession` applies the matching
 * global default thinking level when nothing pins that either.
 */
export function resolveDefaultModel(
	lookup: ModelLookup,
	provider: string | undefined,
	modelId: string | undefined,
): Model<any> | undefined {
	if (provider && modelId) {
		const found = lookup.find(provider, modelId);
		if (found) return found;
	}
	return availableModels(lookup)[0];
}

/** A refused admission. Thrown before any session or network work happens. */
export class AgentAdmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentAdmissionError";
	}
}

function availableModels(lookup: ModelLookup): Model<any>[] {
	return lookup.getAvailable?.() ?? lookup.getAll?.() ?? [];
}

/** Score fuzzy matches the way the gotgenes resolver does. */
function findBestFuzzyMatch(
	all: Model<any>[],
	query: string,
): Model<any> | undefined {
	let best: Model<any> | undefined;
	let bestScore = 0;
	for (const model of all) {
		const id = model.id.toLowerCase();
		const name = model.name?.toLowerCase() ?? "";
		const full = `${model.provider}/${model.id}`.toLowerCase();
		let score = 0;
		if (id === query || full === query) score = 100;
		else if (id.includes(query) || full.includes(query))
			score = 60 + (query.length / Math.max(id.length, 1)) * 30;
		else if (name.includes(query))
			score = 40 + (query.length / Math.max(name.length, 1)) * 20;
		else if (
			query
				.split(/[\s\-/]+/)
				.filter(Boolean)
				.every(
					(part) =>
						id.includes(part) ||
						name.includes(part) ||
						model.provider.toLowerCase().includes(part),
				)
		) {
			score = 20;
		}
		if (score > bestScore) {
			bestScore = score;
			best = model;
		}
	}
	return bestScore >= 20 ? best : undefined;
}

/**
 * Resolve a model string exactly (`provider/modelId`, requiring configured auth),
 * then fuzzily against available models. Returns the model or an error string.
 */
export function resolveModelString(
	input: string,
	lookup: ModelLookup,
): Model<any> | string {
	const available = availableModels(lookup);
	const availableSet = new Set(
		available.map((model) => `${model.provider}/${model.id}`.toLowerCase()),
	);

	const slash = input.indexOf("/");
	if (slash !== -1 && availableSet.has(input.toLowerCase())) {
		const found = lookup.find(input.slice(0, slash), input.slice(slash + 1));
		if (found) return found;
	}

	const fuzzy = findBestFuzzyMatch(
		available.length > 0 ? available : (lookup.getAll?.() ?? []),
		input.toLowerCase(),
	);
	if (fuzzy) {
		const found = lookup.find(fuzzy.provider, fuzzy.id);
		if (found && lookup.hasConfiguredAuth(found)) return found;
	}

	const list = available
		.map((model) => `  ${model.provider}/${model.id}`)
		.sort()
		.join("\n");
	return `Model not found: "${input}".${list ? `\n\nAvailable models:\n${list}` : ""}`;
}

/**
 * Resolve and validate the child's model and thinking level.
 *
 * Model: caller wins unless locked; otherwise the definition, then the global
 * default (`defaultModel`). The parent composer is never consulted. A
 * definition's unresolvable string falls back to the global default; a caller's
 * does not. Thinking is vocabulary-checked and then map-checked against the
 * resolved model; an explicit unsupported caller level refuses, and an
 * unsupported definition level is dropped so `createAgentSession` applies the
 * global default thinking instead.
 */
export function resolveChildModel(input: {
	lookup: ModelLookup;
	/** Global default resolved from Pi settings, independent of the parent. */
	defaultModel?: Model<any>;
	invocation: ResolvedInvocation;
}): ResolvedChildModel {
	const { invocation, defaultModel } = input;

	let model: Model<any> | undefined;
	if (!invocation.modelInput) {
		model = defaultModel;
	} else {
		const resolved = resolveModelString(invocation.modelInput, input.lookup);
		if (typeof resolved === "string") {
			if (invocation.modelFromParams) throw new AgentAdmissionError(resolved);
			model = defaultModel;
		} else {
			model = resolved;
		}
	}
	if (!model) {
		throw new AgentAdmissionError(
			`no model resolved for the child: the agent defines none, the call supplied none, and no global default model is available`,
		);
	}

	const candidate = invocation.thinking;
	if (candidate === undefined) return { model };

	const supported = new Set<string>(getSupportedThinkingLevels(model));
	if (!supported.has(candidate)) {
		// A caller's bad value is visible and refused; a definition's value is
		// dropped so the child inherits rather than silently clamping to `off`.
		if (invocation.thinkingFromParams) {
			throw new AgentAdmissionError(
				`thinking level "${candidate}" is not supported by model "${model.provider}/${model.id}" (supported: ${[...supported].join(", ")})`,
			);
		}
		return { model };
	}
	return { model, thinking: candidate as ModelThinkingLevel };
}
