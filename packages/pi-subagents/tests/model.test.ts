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
	parent?: { parentModel?: Model<any>; parentThinking?: string },
) {
	return resolveChildModel({
		lookup: lookup(model),
		parentModel: parent?.parentModel,
		parentThinking: parent?.parentThinking,
		invocation: resolveInvocation(def, params),
	});
}

describe("resolveChildModel", () => {
	it("uses an exact definition model", () => {
		const model = fakeModel("plexus", "m");
		expect(resolve(definition({ model: "plexus/m" }), model).model).toBe(model);
	});

	it("inherits the parent model when nothing pins one", () => {
		const parent = fakeModel("plexus", "parent");
		expect(
			resolve(definition(), undefined, {}, { parentModel: parent }).model,
		).toBe(parent);
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
		const parent = fakeModel("plexus", "parent");
		expect(() =>
			resolve(
				definition(),
				undefined,
				{ model: "plexus/nope" },
				{ parentModel: parent },
			),
		).toThrow(AgentAdmissionError);
	});

	it("falls back to the parent for an unresolvable definition model", () => {
		const parent = fakeModel("plexus", "parent");
		expect(
			resolve(
				definition({ model: "plexus/nope" }),
				undefined,
				{},
				{ parentModel: parent },
			).model,
		).toBe(parent);
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

	it("inherits a supported parent thinking level", () => {
		const model = fakeModel("plexus", "m", true);
		expect(
			resolve(
				definition({ model: "plexus/m" }),
				model,
				{},
				{ parentThinking: "low" },
			).thinking,
		).toBe("low");
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
