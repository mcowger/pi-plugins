import { describe, expect, it } from "bun:test";
import {
	AGENT_TOOL_NAME,
	GET_RESULT_TOOL_NAME,
	SPAWNER_TOOL_NAMES,
	STEER_TOOL_NAME,
} from "../src/constants.js";
import { decideToolCall, gateForSession } from "../src/gate.js";
import { getLineageRegistry } from "../src/lineage.js";
import { resolveToolPolicy } from "../src/selectors.js";
import type { Lineage } from "../src/types.js";

const root: Lineage = { sessionId: "root", depth: 0, ceiling: 1 };
const child: Lineage = { sessionId: "child", depth: 1, ceiling: 1 };

describe("decideToolCall", () => {
	it("allows everything for an untracked session", () => {
		expect(decideToolCall(undefined, AGENT_TOOL_NAME)).toBeUndefined();
	});

	it("hides the spawner at the ceiling", () => {
		for (const name of SPAWNER_TOOL_NAMES) {
			expect(decideToolCall(child, name)?.block).toBe(true);
		}
		expect(decideToolCall(root, AGENT_TOOL_NAME)).toBeUndefined();
	});

	it("applies the frozen selector policy to direct and nested names", () => {
		const lineage: Lineage = {
			...root,
			policy: resolveToolPolicy(
				["codemode", "mcp__exa__web_search_exa"],
				["mcp__exa__web_search_exa"],
			),
		};
		expect(decideToolCall(lineage, "codemode")).toBeUndefined();
		expect(decideToolCall(lineage, "mcp__exa__web_search_exa")?.block).toBe(
			true,
		);
		expect(decideToolCall(lineage, "write")?.block).toBe(true);
	});

	it("[] blocks everything, including codemode-nested calls", () => {
		const lineage: Lineage = { ...root, policy: resolveToolPolicy([], []) };
		expect(decideToolCall(lineage, "read")?.block).toBe(true);
		expect(decideToolCall(lineage, "codemode")?.block).toBe(true);
	});

	it("is exposed through the session adapter", () => {
		getLineageRegistry().register(child);
		getLineageRegistry().register(root);
		expect(gateForSession("child", GET_RESULT_TOOL_NAME)?.block).toBe(true);
		expect(gateForSession("root", STEER_TOOL_NAME)).toBeUndefined();
	});
});
