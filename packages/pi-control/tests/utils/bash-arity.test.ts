import { describe, expect, it } from "bun:test";
import { suggestSessionPattern } from "../../src/utils/bash-arity.js";

describe("suggestSessionPattern", () => {
	it("suggests git <subcommand>* for git commands (arity covers entire command)", () => {
		expect(suggestSessionPattern("git status")).toBe("git status*");
		expect(suggestSessionPattern("git diff")).toBe("git diff*");
		expect(suggestSessionPattern("git log --oneline")).toBe("git log *");
	});

	it("suggests git commit * for git commit (arity 2)", () => {
		expect(suggestSessionPattern('git commit -m "fix"')).toBe("git commit *");
		expect(suggestSessionPattern("git commit --amend")).toBe("git commit *");
	});

	it("suggests npm install * for npm install", () => {
		expect(suggestSessionPattern("npm install lodash")).toBe("npm install *");
	});

	it("suggests npm run dev* for npm run (specific arity 3)", () => {
		expect(suggestSessionPattern("npm run dev")).toBe("npm run dev*");
		expect(suggestSessionPattern("npm run build")).toBe("npm run build*");
	});

	it("suggests rm * for destructive commands (arity 1)", () => {
		expect(suggestSessionPattern("rm -rf node_modules")).toBe("rm *");
		expect(suggestSessionPattern("rm /tmp/foo")).toBe("rm *");
	});

	it("suggests docker compose up* for docker compose (arity covers all tokens)", () => {
		expect(suggestSessionPattern("docker compose up")).toBe(
			"docker compose up*",
		);
		expect(suggestSessionPattern("docker compose down")).toBe(
			"docker compose down*",
		);
	});

	it("suggests docker build * for docker build", () => {
		expect(suggestSessionPattern("docker build -t myapp .")).toBe(
			"docker build *",
		);
	});

	it("falls back to first word for unknown commands", () => {
		expect(suggestSessionPattern("mytool --verbose")).toBe("mytool *");
	});

	it("suggests cp * for cp (arity 2), keeping source pattern", () => {
		expect(suggestSessionPattern("cp /tmp/a /tmp/b")).toBe("cp /tmp/a *");
	});

	it("handles empty command", () => {
		expect(suggestSessionPattern("")).toBe("*");
	});

	it("handles single-word command", () => {
		expect(suggestSessionPattern("ls")).toBe("ls*");
	});

	it("longest prefix wins: npm run over npm", () => {
		expect(suggestSessionPattern("npm run dev")).toBe("npm run dev*");
		expect(suggestSessionPattern("npm install lodash")).toBe("npm install *");
	});

	it("suggests gh pr create * for GitHub CLI pr subcommands", () => {
		expect(suggestSessionPattern("gh pr create")).toBe("gh pr create*");
		expect(suggestSessionPattern("gh pr view 42")).toBe("gh pr view *");
	});

	it("suggests gh * for other GitHub CLI commands", () => {
		expect(suggestSessionPattern("gh auth status")).toBe("gh auth *");
	});

	it("handles extra whitespace in command", () => {
		expect(suggestSessionPattern("  git   status  ")).toBe("git status*");
	});
});
