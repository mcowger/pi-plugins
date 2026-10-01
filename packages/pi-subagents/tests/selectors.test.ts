import { describe, expect, it } from "bun:test";
import { isToolAllowed, resolveToolPolicy } from "../src/selectors.js";

const cases: Array<{
	name: string;
	included: string[] | undefined;
	excluded: string[];
	expect: Record<string, boolean>;
}> = [
	{
		name: "omitted/omitted: all available",
		included: undefined,
		excluded: [],
		expect: { read: true, write: true },
	},
	{
		name: "[]: none",
		included: [],
		excluded: [],
		expect: { read: false, codemode: false },
	},
	{
		name: "[read, codemode] minus [read]: codemode only",
		included: ["read", "codemode"],
		excluded: ["read"],
		expect: { read: false, codemode: true, write: false },
	},
	{
		name: "omitted minus [write]: all except write",
		included: undefined,
		excluded: ["write"],
		expect: { read: true, write: false, codemode: true },
	},
];

describe("tool selectors", () => {
	for (const testCase of cases) {
		it(testCase.name, () => {
			const policy = resolveToolPolicy(testCase.included, testCase.excluded);
			for (const [tool, allowed] of Object.entries(testCase.expect)) {
				expect(isToolAllowed(policy, tool)).toBe(allowed);
			}
		});
	}

	it("exclusion always wins over inclusion", () => {
		const policy = resolveToolPolicy(
			["mcp__exa__web_fetch_exa", "mcp__exa__web_search_exa"],
			["mcp__exa__web_fetch_exa"],
		);
		expect(isToolAllowed(policy, "mcp__exa__web_fetch_exa")).toBe(false);
		expect(isToolAllowed(policy, "mcp__exa__web_search_exa")).toBe(true);
	});

	it("matches MCP names across Pi's - to _ normalization", () => {
		const legacy = resolveToolPolicy(
			["mcp__dev-radius__read-file", "mcp__dev-radius__delete"],
			["mcp__dev-radius__delete"],
		);
		expect(isToolAllowed(legacy, "mcp__dev_radius__read_file")).toBe(true);
		expect(isToolAllowed(legacy, "mcp__dev_radius__delete")).toBe(false);

		const current = resolveToolPolicy(undefined, ["mcp__dev_radius__delete"]);
		expect(isToolAllowed(current, "mcp__dev-radius__delete")).toBe(false);
		expect(isToolAllowed(current, "mcp__dev-radius__read-file")).toBe(true);
	});

	it("does not rewrite non-MCP tool names", () => {
		const policy = resolveToolPolicy(undefined, ["my-tool"]);
		expect(isToolAllowed(policy, "my_tool")).toBe(true);
		expect(isToolAllowed(policy, "my-tool")).toBe(false);
	});

	it("an undefined policy allows everything", () => {
		expect(isToolAllowed(undefined, "anything")).toBe(true);
	});
});
