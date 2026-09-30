import { describe, expect, it } from "bun:test";
import { resolveInvocation } from "../src/invocation.js";
import { DEFAULT_AGENT_TOOLS, type AgentDefinition } from "../src/types.js";

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

describe("resolveInvocation", () => {
	it("lets the caller win and the definition fill the gaps", () => {
		const resolved = resolveInvocation(
			definition({ model: "plexus/agent", thinking: "low", maxTurns: 10 }),
			{
				model: "plexus/caller",
				thinking: "high",
			},
		);
		expect(resolved.modelInput).toBe("plexus/caller");
		expect(resolved.modelFromParams).toBe(true);
		expect(resolved.thinking).toBe("high");
		expect(resolved.maxTurns).toBe(10);
	});

	it("locked: true withholds every field the file sets", () => {
		const resolved = resolveInvocation(
			definition({ model: "plexus/agent", maxTurns: 10, locked: true }),
			{ model: "plexus/caller", max_turns: 99 },
		);
		expect(resolved.modelInput).toBe("plexus/agent");
		expect(resolved.modelFromParams).toBe(false);
		expect(resolved.maxTurns).toBe(10);
		expect(resolved.discarded).toContain("model");
		expect(resolved.discarded).toContain("max_turns");
	});

	it("a lock list withholds named fields even when unset", () => {
		const resolved = resolveInvocation(
			definition({ locked: ["run_in_background"] }),
			{
				run_in_background: true,
			},
		);
		expect(resolved.runInBackground).toBe(false);
		expect(resolved.discarded).toEqual(["run_in_background"]);
	});

	it("does not flag a caller that passed the agent's own value", () => {
		const resolved = resolveInvocation(
			definition({ model: "plexus/m", locked: ["model"] }),
			{
				model: "plexus/m",
			},
		);
		expect(resolved.discarded).toEqual([]);
	});

	it("defaults inheritContext and runInBackground to false", () => {
		const resolved = resolveInvocation(definition(), {});
		expect(resolved.inheritContext).toBe(false);
		expect(resolved.runInBackground).toBe(false);
	});
});
