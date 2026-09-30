import { describe, expect, it } from "bun:test";
import {
	AGENT_TOOL_NAME,
	GET_RESULT_TOOL_NAME,
	STEER_TOOL_NAME,
} from "../src/constants.js";
import { resolveApprovedExtensionRefs } from "../src/extensions.js";
import { AgentAdmissionError } from "../src/model.js";
import {
	DEFAULT_AGENT_TOOLS,
	type AgentDefinition,
	type OperatorConfig,
} from "../src/types.js";

function definition(overrides: Partial<AgentDefinition>): AgentDefinition {
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

const config: OperatorConfig = {
	maxDepth: 1,
	approvedExtensions: {
		research: "/ext/research.ts",
		review: "/ext/review.ts",
	},
	excludedExtensions: ["review"],
};

describe("resolveApprovedExtensionRefs", () => {
	it("inherits the approved set when per-agent is omitted", () => {
		expect(
			resolveApprovedExtensionRefs(config, definition({}), undefined),
		).toEqual(["/ext/research.ts"]);
	});

	it("selects none when per-agent is empty", () => {
		expect(
			resolveApprovedExtensionRefs(
				config,
				definition({ extensions: [] }),
				undefined,
			),
		).toEqual([]);
	});

	it("appends per-call refs from approved sources only", () => {
		expect(
			resolveApprovedExtensionRefs(config, definition({ extensions: [] }), [
				"research",
			]),
		).toEqual(["/ext/research.ts"]);
	});

	it("refuses unapproved sources", () => {
		expect(() =>
			resolveApprovedExtensionRefs(config, definition({}), ["nope"]),
		).toThrow(AgentAdmissionError);
	});

	it("lets excluded extensions win", () => {
		expect(
			resolveApprovedExtensionRefs(
				config,
				definition({ extensions: ["review"] }),
				undefined,
			),
		).toEqual([]);
	});
});

describe("tool names match the Paseo adapter contract", () => {
	it("uses the exact dispatch names", () => {
		expect([AGENT_TOOL_NAME, GET_RESULT_TOOL_NAME, STEER_TOOL_NAME]).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
		]);
	});
});
