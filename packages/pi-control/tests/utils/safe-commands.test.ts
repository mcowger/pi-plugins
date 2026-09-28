import { describe, expect, it } from "bun:test";
import { SAFE_BASH_PATTERNS } from "../../src/utils/safe-commands.js";

describe("SAFE_BASH_PATTERNS", () => {
	it("excludes commands that execute arbitrary source or subcommands", () => {
		for (const pattern of [
			"python -c *",
			"python3 -c *",
			"node -e *",
			"node --eval *",
			"bun -e *",
			"bun --eval *",
			"deno eval *",
			"env *",
		]) {
			expect(SAFE_BASH_PATTERNS).not.toContain(pattern);
		}
	});

	it("retains bare env for read-only environment inspection", () => {
		expect(SAFE_BASH_PATTERNS).toContain("env");
	});

	it("covers bare stdin-filter forms so pipelines never fall through to auto", () => {
		// Regression: `ls … | head | find … | head` fell through to the
		// Decisions model because bare `head` matched no `$safe-bash` rule
		// (`head *` requires an argument).
		for (const pattern of [
			"cat",
			"head",
			"tail",
			"sort",
			"grep",
			"wc",
			"jq",
			"find",
			"git remote",
			"echo",
			"lsof",
		]) {
			expect(SAFE_BASH_PATTERNS).toContain(pattern);
		}
	});
});
