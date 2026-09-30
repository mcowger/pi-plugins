import type {
	AgentDefinition,
	LockableField,
	LockDeclaration,
} from "./types.js";

export interface InvocationParams {
	model?: string;
	thinking?: string;
	max_turns?: number;
	inherit_context?: boolean;
	run_in_background?: boolean;
}

export interface ResolvedInvocation {
	modelInput?: string;
	/** True when the winning model string came from the caller. */
	modelFromParams: boolean;
	thinking?: string;
	thinkingFromParams: boolean;
	maxTurns?: number;
	inheritContext: boolean;
	runInBackground: boolean;
	/** Locked fields whose caller value differed and was discarded, in field order. */
	discarded: LockableField[];
}

interface FieldResolution<T> {
	value: T | undefined;
	source: "caller" | "agent" | "none";
	discarded: boolean;
}

/** `true` withholds every field the file sets; a list names fields outright. */
function isLocked(
	field: LockableField,
	agentValue: unknown,
	locked: LockDeclaration | undefined,
): boolean {
	if (locked === undefined) return false;
	return locked === true ? agentValue !== undefined : locked.includes(field);
}

function resolveField<T>(
	field: LockableField,
	agentValue: T | undefined,
	callerValue: T | undefined,
	locked: LockDeclaration | undefined,
): FieldResolution<T> {
	if (!isLocked(field, agentValue, locked) && callerValue !== undefined) {
		return { value: callerValue, source: "caller", discarded: false };
	}
	const discarded = callerValue !== undefined && callerValue !== agentValue;
	return {
		value: agentValue,
		source: agentValue !== undefined ? "agent" : "none",
		discarded,
	};
}

/**
 * Merge an agent definition with a spawn call's parameters.
 *
 * The caller wins by default and the definition fills the gaps. A `locked:`
 * declaration is the only case where a caller's value is discarded.
 */
export function resolveInvocation(
	definition: AgentDefinition,
	params: InvocationParams,
): ResolvedInvocation {
	const locked = definition.locked;
	const model = resolveField("model", definition.model, params.model, locked);
	const thinking = resolveField(
		"thinking",
		definition.thinking,
		params.thinking,
		locked,
	);
	const maxTurns = resolveField(
		"max_turns",
		definition.maxTurns,
		params.max_turns,
		locked,
	);
	const inheritContext = resolveField(
		"inherit_context",
		definition.inheritContext,
		params.inherit_context,
		locked,
	);
	const runInBackground = resolveField(
		"run_in_background",
		definition.runInBackground,
		params.run_in_background,
		locked,
	);

	const discarded: LockableField[] = [];
	const fields: Array<[LockableField, FieldResolution<unknown>]> = [
		["model", model],
		["thinking", thinking],
		["max_turns", maxTurns],
		["inherit_context", inheritContext],
		["run_in_background", runInBackground],
	];
	for (const [field, resolution] of fields) {
		if (resolution.discarded) discarded.push(field);
	}

	return {
		modelInput: model.value,
		modelFromParams: model.source === "caller",
		thinking: thinking.value,
		thinkingFromParams: thinking.source === "caller",
		maxTurns: maxTurns.value,
		inheritContext: inheritContext.value ?? false,
		runInBackground: runInBackground.value ?? false,
		discarded,
	};
}
