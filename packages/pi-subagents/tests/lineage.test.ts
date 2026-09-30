import { describe, expect, it } from "bun:test";
import { canSpawn, childLineage } from "../src/lineage.js";
import { resolveToolPolicy } from "../src/selectors.js";
import type { Lineage } from "../src/types.js";

function root(ceiling: number): Lineage {
	return { sessionId: "root", depth: 0, ceiling };
}

describe("lineage", () => {
	it("increments depth and inherits the ceiling", () => {
		const child = childLineage(root(2), "child", {
			runId: "r1",
			policy: resolveToolPolicy(undefined, []),
		});
		expect(child.depth).toBe(1);
		expect(child.ceiling).toBe(2);
		expect(child.parentSessionId).toBe("root");
		expect(child.runId).toBe("r1");
	});

	it("only narrows with a per-agent ceiling", () => {
		const narrowed = childLineage(root(5), "child", {
			runId: "r1",
			policy: resolveToolPolicy(undefined, []),
			agentMaxDepth: 2,
		});
		expect(narrowed.ceiling).toBe(2);

		const widened = childLineage(root(1), "child", {
			runId: "r1",
			policy: resolveToolPolicy(undefined, []),
			agentMaxDepth: 9,
		});
		expect(widened.ceiling).toBe(1);
	});

	it("hides the spawner at the ceiling", () => {
		const atCeiling: Lineage = { sessionId: "child", depth: 1, ceiling: 1 };
		const below: Lineage = { sessionId: "root", depth: 0, ceiling: 1 };
		expect(canSpawn(atCeiling)).toBe(false);
		expect(canSpawn(below)).toBe(true);
	});
});
