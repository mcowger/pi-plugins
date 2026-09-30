import { describe, expect, it } from "bun:test";
import type { ControlsResolvedConfig, Policy, Rule } from "../../src/config.js";
import { universallyDeniedTools } from "../../src/utils/tool-hiding.js";

const TOOLS = ["read", "write", "edit", "bash"];

function config(
	policies: Record<string, Policy>,
	overrides: Partial<ControlsResolvedConfig> = {},
): ControlsResolvedConfig {
	return {
		policies,
		locations: Object.fromEntries(
			Object.keys(policies).map((name) => [`/srv/${name}`, name]),
		),
		approvalRules: [],
		defaultPolicy: null,
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: null,
		...overrides,
	};
}

const readonly: Policy = {
	defaultAction: "deny",
	rules: [
		{ action: "allow", tool: "read" },
		{ action: "allow", tool: "bash", pattern: "cat *" },
	],
};

describe("universallyDeniedTools", () => {
	it("keeps bash when a deny-by-default policy allows bash patterns", () => {
		expect(universallyDeniedTools(TOOLS, config({ readonly }))).toEqual([
			"write",
			"edit",
		]);
	});

	it("hides bash when no active policy can run any bash command", () => {
		const locked: Policy = {
			defaultAction: "deny",
			rules: [
				{ action: "allow", tool: "read" },
				{ action: "deny", tool: "bash", pattern: "rm *" },
			],
		};
		expect(universallyDeniedTools(TOOLS, config({ locked }))).toEqual([
			"write",
			"edit",
			"bash",
		]);
	});

	it("keeps bash for ask, nudge, log, and auto pattern rules", () => {
		for (const action of ["ask", "log", "auto"] as const) {
			const policy: Policy = {
				defaultAction: "deny",
				rules: [{ action, tool: "bash", pattern: "git *" }],
			};
			expect(universallyDeniedTools(["bash"], config({ policy }))).toEqual([]);
		}
		const nudge: Policy = {
			defaultAction: "deny",
			rules: [
				{ action: "nudge", tool: "bash", pattern: "grep *", message: "m" },
			],
		};
		expect(universallyDeniedTools(["bash"], config({ nudge }))).toEqual([]);
	});

	it("keeps bash when a saved approval allows a pattern for the policy", () => {
		const locked: Policy = { defaultAction: "deny", rules: [] };
		const approval: Rule = {
			action: "allow",
			tool: "bash",
			pattern: "make *",
			policy: "locked",
		};
		const other: Rule = { ...approval, policy: "elsewhere" };
		expect(
			universallyDeniedTools(
				["bash"],
				config({ locked }, { approvalRules: [approval] }),
			),
		).toEqual([]);
		expect(
			universallyDeniedTools(
				["bash"],
				config({ locked }, { approvalRules: [other] }),
			),
		).toEqual(["bash"]);
	});

	it("keeps a non-bash tool a saved approval allows", () => {
		const locked: Policy = { defaultAction: "deny", rules: [] };
		expect(
			universallyDeniedTools(
				["write", "edit"],
				config(
					{ locked },
					{
						approvalRules: [
							{ action: "allow", tool: "write", policy: "locked" },
						],
					},
				),
			),
		).toEqual(["edit"]);
	});

	it("hides only what every active policy denies", () => {
		const open: Policy = { defaultAction: "allow", rules: [] };
		expect(
			universallyDeniedTools(
				TOOLS,
				config({ readonly, open }, { defaultPolicy: "open" }),
			),
		).toEqual([]);
	});

	it("hides nothing with no active policies", () => {
		expect(
			universallyDeniedTools(TOOLS, config({}, { locations: {} })),
		).toEqual([]);
	});
});
