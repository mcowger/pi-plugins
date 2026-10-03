import { describe, expect, it } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveInvocation } from "../src/invocation.js";
import {
	AgentAdmissionError,
	type ModelLookup,
	resolveChildModel,
} from "../src/model.js";
import { DEFAULT_AGENT_TOOLS, type AgentDefinition } from "../src/types.js";

function fakeModel(
	provider: string,
	id: string,
	reasoning = false,
): Model<any> {
	return { provider, id, name: id, reasoning } as unknown as Model<any>;
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "test",
		path: "/agents/test.md",
		source: "user",
		tools: [...DEFAULT_AGENT_TOOLS],
		promptMode: "append",
		instructions: "",
		enabled: true,
		...overrides,
	};
}

function lookup(model: Model<any> | undefined, auth = true): ModelLookup {
	const all = model ? [model] : [];
	return {
		find: (provider, id) =>
			model && model.provider === provider && model.id === id
				? model
				: undefined,
		hasConfiguredAuth: () => auth,
		getAll: () => all,
		getAvailable: () => all,
	};
}

function resolve(
	def: AgentDefinition,
	model: Model<any> | undefined,
	params: { model?: string; thinking?: string } = {},
	defaultModel?: Model<any>,
) {
	return resolveChildModel({
		lookup: lookup(model),
		defaultModel,
		invocation: resolveInvocation(def, params),
	});
}

describe("resolveChildModel", () => {
	it("uses an exact definition model", () => {
		const model = fakeModel("plexus", "m");
		expect(resolve(definition({ model: "plexus/m" }), model).model).toBe(model);
	});

	it("uses the global default model when nothing pins one", () => {
		const globalDefault = fakeModel("plexus", "global-default");
		expect(resolve(definition(), undefined, {}, globalDefault).model).toBe(
			globalDefault,
		);
	});

	it("refuses when no model exists anywhere", () => {
		expect(() => resolve(definition(), undefined)).toThrow(AgentAdmissionError);
	});

	it("lets a lock discard a conflicting caller model", () => {
		const model = fakeModel("plexus", "m");
		const result = resolve(
			definition({ model: "plexus/m", locked: ["model"] }),
			model,
			{ model: "plexus/other" },
		);
		expect(result.model).toBe(model);
	});

	it("refuses an unresolvable caller model", () => {
		const globalDefault = fakeModel("plexus", "global-default");
		expect(() =>
			resolve(definition(), undefined, { model: "plexus/nope" }, globalDefault),
		).toThrow(AgentAdmissionError);
	});

	it("falls back to the global default for an unresolvable definition model", () => {
		const globalDefault = fakeModel("plexus", "global-default");
		expect(
			resolve(
				definition({ model: "plexus/nope" }),
				undefined,
				{},
				globalDefault,
			).model,
		).toBe(globalDefault);
	});

	it("resolves a model fuzzily when the exact ref is unknown", () => {
		const model = fakeModel("plexus", "claude-haiku-4-5");
		expect(resolve(definition({ model: "haiku" }), model).model).toBe(model);
	});

	it("validates thinking against the resolved model map", () => {
		const model = fakeModel("plexus", "m", true);
		expect(
			resolve(
				definition({
					model: "plexus/m",
					thinking: "high",
					locked: ["thinking"],
				}),
				model,
			).thinking,
		).toBe("high");
	});

	it("refuses an unsupported caller thinking level", () => {
		const model = fakeModel("plexus", "m", true);
		expect(() =>
			resolve(definition({ model: "plexus/m" }), model, { thinking: "xhigh" }),
		).toThrow(AgentAdmissionError);
	});

	it("drops an unsupported definition thinking level instead of clamping", () => {
		const model = fakeModel("plexus", "m", true);
		expect(
			resolve(definition({ model: "plexus/m", thinking: "xhigh" }), model)
				.thinking,
		).toBeUndefined();
	});

	it("validates a definition thinking level against the global default model", () => {
		const globalDefault = fakeModel("plexus", "global-default", true);
		expect(
			resolve(definition({ thinking: "low" }), undefined, {}, globalDefault)
				.thinking,
		).toBe("low");
	});

	it("leaves thinking undefined when nothing pins one", () => {
		const globalDefault = fakeModel("plexus", "global-default", true);
		expect(
			resolve(definition(), undefined, {}, globalDefault).thinking,
		).toBeUndefined();
	});

	it("only supports off for a non-reasoning model", () => {
		const model = fakeModel("plexus", "m", false);
		expect(
			resolve(definition({ model: "plexus/m", thinking: "off" }), model)
				.thinking,
		).toBe("off");
		expect(
			resolve(definition({ model: "plexus/m", thinking: "high" }), model)
				.thinking,
		).toBeUndefined();
	});
});
