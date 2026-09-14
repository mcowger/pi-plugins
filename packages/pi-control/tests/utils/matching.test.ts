import { describe, expect, it } from "bun:test";
import {
	matchRule,
	matchRuleWithDetails,
	mostRestrictive,
	specificityScore,
} from "../../src/utils/matching.js";
import type { Policy } from "../../src/config.js";

describe("specificityScore", () => {
	it("returns full length when no wildcard", () => {
		expect(specificityScore("github_create_pull_request")).toBe(26);
	});

	it("counts chars before first wildcard", () => {
		expect(specificityScore("git commit *")).toBe(11);
		expect(specificityScore("git *")).toBe(4);
		expect(specificityScore("*")).toBe(0);
	});

	it("handles ? wildcard", () => {
		expect(specificityScore("git?commit")).toBe(3);
	});
});

describe("mostRestrictive", () => {
	it("deny wins over everything", () => {
		expect(mostRestrictive(["allow", "log", "ask", "deny"])).toBe("deny");
	});

	it("ask beats log and allow", () => {
		expect(mostRestrictive(["allow", "log", "ask"])).toBe("ask");
	});

	it("log beats allow", () => {
		expect(mostRestrictive(["allow", "log"])).toBe("log");
	});

	it("nudge beats allow but loses to log", () => {
		expect(mostRestrictive(["allow", "nudge"])).toBe("nudge");
		expect(mostRestrictive(["nudge", "log"])).toBe("log");
		expect(mostRestrictive(["nudge", "ask"])).toBe("ask");
		expect(mostRestrictive(["nudge", "deny"])).toBe("deny");
	});

	it("defaults to allow for empty list", () => {
		expect(mostRestrictive([])).toBe("allow");
	});
});

describe("matchRule", () => {
	const strictPolicy: Policy = {
		defaultAction: "deny",
		rules: [
			{ action: "allow", tool: "bash", pattern: "git *" },
			{ action: "ask", tool: "bash", pattern: "git commit *" },
			{ action: "deny", tool: "bash", pattern: "rm *" },
			{ action: "log", tool: "read" },
			{ action: "deny", tool: "write" },
			{ action: "deny", tool: "github_*" },
		],
	};

	it("uses defaultAction when no rule matches", () => {
		expect(matchRule(strictPolicy, "find", null)).toBe("deny");
	});

	it("matches exact tool name", () => {
		expect(matchRule(strictPolicy, "write", null)).toBe("deny");
	});

	it("matches tool glob", () => {
		expect(matchRule(strictPolicy, "github_create_pr", null)).toBe("deny");
	});

	it("matches bash command pattern", () => {
		expect(matchRule(strictPolicy, "bash", "git status")).toBe("allow");
	});

	it("prefers more specific rule (git commit * over git *)", () => {
		// git commit * has score 11, git * has score 4 → ask wins
		expect(matchRule(strictPolicy, "bash", "git commit -m 'hi'")).toBe("ask");
	});

	it("matches rm command", () => {
		expect(matchRule(strictPolicy, "bash", "rm /tmp/foo")).toBe("deny");
	});

	it("uses tiebreaker: allow beats ask at same specificity", () => {
		const policy: Policy = {
			defaultAction: "deny",
			rules: [
				{ action: "allow", tool: "bash", pattern: "git *" },
				{ action: "ask", tool: "bash", pattern: "git *" },
			],
		};
		expect(matchRule(policy, "bash", "git status")).toBe("allow");
	});

	it("non-bash tool with log action proceeds", () => {
		expect(matchRule(strictPolicy, "read", null)).toBe("log");
	});

	// Regression: minimatch treated command strings as file paths, so patterns
	// like "find *" failed to match commands with deep absolute paths because
	// minimatch's ** doesn't span the leading / in path segments.
	it("matches find with a deep absolute path argument", () => {
		const policy: Policy = {
			defaultAction: "deny",
			rules: [{ action: "allow", tool: "bash", pattern: "find *" }],
		};
		expect(matchRule(policy, "bash", "find /a/b/c/d -type f -name *.md")).toBe(
			"allow",
		);
	});

	it("matches cat with an absolute path argument", () => {
		const policy: Policy = {
			defaultAction: "deny",
			rules: [{ action: "allow", tool: "bash", pattern: "cat *" }],
		};
		expect(matchRule(policy, "bash", "cat /etc/hosts")).toBe("allow");
	});

	// Regression: git commit -m with a multi-line body passes newlines in the
	// command string. The `.*` in the converted pattern regex must use the
	// dotAll (`s`) flag so it crosses newline boundaries; without it,
	// `git commit*` silently failed to match and the rule was never triggered,
	// letting the commit through without asking for confirmation.
	it("matches git commit with a multi-line commit message", () => {
		const policy: Policy = {
			defaultAction: "allow",
			rules: [{ action: "ask", tool: "bash", pattern: "git commit*" }],
		};
		const multiLineCommit =
			'git commit -m "feat: do something\n\n- detail one\n- detail two"';
		expect(matchRule(policy, "bash", multiLineCommit)).toBe("ask");
	});
});

describe("nudge action", () => {
	const nudgePolicy: Policy = {
		defaultAction: "allow",
		rules: [
			{ action: "nudge", tool: "read", message: "use pluck_read instead" },
			{ action: "nudge", tool: "grep", message: "use pluck_grep instead" },
		],
	};

	it("returns nudge action for a matching tool", () => {
		expect(matchRule(nudgePolicy, "read", null)).toBe("nudge");
	});

	it("returns nudge action for another matching tool", () => {
		expect(matchRule(nudgePolicy, "grep", null)).toBe("nudge");
	});

	it("returns allow (defaultAction) for a non-nudged tool", () => {
		expect(matchRule(nudgePolicy, "write", null)).toBe("allow");
	});

	it("matchRuleWithDetails includes the nudgeMessage", () => {
		const result = matchRuleWithDetails(nudgePolicy, "read", null);
		expect(result.action).toBe("nudge");
		expect(result.nudgeMessage).toBe("use pluck_read instead");
	});

	it("nudge message is undefined when action is not nudge", () => {
		const result = matchRuleWithDetails(nudgePolicy, "write", null);
		expect(result.action).toBe("allow");
		expect(result.nudgeMessage).toBeUndefined();
	});

	it("at equal specificity, nudge (more permissive) wins over deny in single-rule match — deny must come from mostRestrictive", () => {
		// Within a single policy, the tiebreaker is most-permissive wins (lower ACTION_PRIORITY number).
		// nudge (1) < deny (3) → nudge wins the single-rule match.
		// To combine nudge + deny across targets use mostRestrictive(), which gives deny.
		const mixedPolicy: Policy = {
			defaultAction: "allow",
			rules: [
				{ action: "nudge", tool: "read", message: "use pluck_read" },
				{ action: "deny", tool: "read" },
			],
		};
		expect(matchRule(mixedPolicy, "read", null)).toBe("nudge");
	});

	it("mostRestrictive correctly picks deny over nudge", () => {
		expect(mostRestrictive(["nudge", "deny"])).toBe("deny");
	});
});
