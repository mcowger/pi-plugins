import { describe, expect, it } from "bun:test";
import { parseAgentDefinition } from "../src/definition.js";
import { DEFAULT_AGENT_TOOLS } from "../src/types.js";

const SEED = `---
description: Read-only recon of a repo.
tools: read, bash, grep, find, ls
model: plexus/deepseek-v4.1-flash
thinking: off
max_turns: 40
prompt_mode: replace
locked: [model, thinking]
---

You are a read-only exploration agent.
`;

describe("parseAgentDefinition (gotgenes frontmatter)", () => {
	it("parses a seed file", () => {
		const definition = parseAgentDefinition(
			"explore",
			"/agents/explore.md",
			"user",
			SEED,
		);
		expect(definition.name).toBe("explore");
		expect(definition.description).toBe("Read-only recon of a repo.");
		expect(definition.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
		expect(definition.model).toBe("plexus/deepseek-v4.1-flash");
		expect(definition.thinking).toBe("off");
		expect(definition.maxTurns).toBe(40);
		expect(definition.promptMode).toBe("replace");
		expect(definition.locked).toEqual(["model", "thinking"]);
		expect(definition.instructions).toBe(
			"You are a read-only exploration agent.",
		);
		expect(definition.enabled).toBe(true);
	});

	it("defaults tools to the seven built-ins", () => {
		const definition = parseAgentDefinition(
			"x",
			"/x.md",
			"user",
			"---\ndescription: x\n---\n",
		);
		expect(definition.tools).toEqual([...DEFAULT_AGENT_TOOLS]);
	});

	it("accepts tools: none, flow lists, and block lists", () => {
		expect(
			parseAgentDefinition("x", "/x.md", "user", "---\ntools: none\n---\n")
				.tools,
		).toEqual([]);
		expect(
			parseAgentDefinition(
				"x",
				"/x.md",
				"user",
				"---\ntools: [read, grep]\n---\n",
			).tools,
		).toEqual(["read", "grep"]);
		expect(
			parseAgentDefinition(
				"x",
				"/x.md",
				"user",
				"---\ntools:\n  - read\n  - grep\n---\n",
			).tools,
		).toEqual(["read", "grep"]);
	});

	it("supports locked: true and the comma spelling", () => {
		expect(
			parseAgentDefinition("x", "/x.md", "user", "---\nlocked: true\n---\n")
				.locked,
		).toBe(true);
		expect(
			parseAgentDefinition(
				"x",
				"/x.md",
				"user",
				"---\nlocked: model, thinking\n---\n",
			).locked,
		).toEqual(["model", "thinking"]);
		expect(
			parseAgentDefinition("x", "/x.md", "user", "---\nlocked: [bogus]\n---\n")
				.locked,
		).toBeUndefined();
	});

	it("parses display_name, run_in_background, prompt_mode, and enabled", () => {
		const definition = parseAgentDefinition(
			"x",
			"/x.md",
			"user",
			"---\ndisplay_name: Recon\ndescription: x\nrun_in_background: true\nprompt_mode: replace\nenabled: false\n---\n",
		);
		expect(definition.displayName).toBe("Recon");
		expect(definition.runInBackground).toBe(true);
		expect(definition.promptMode).toBe("replace");
		expect(definition.enabled).toBe(false);
	});

	it("keeps extensions and maxDepth, and rejects a bad maxDepth", () => {
		const definition = parseAgentDefinition(
			"x",
			"/x.md",
			"user",
			"---\nextensions: [a, b]\nmaxDepth: 2\n---\n",
		);
		expect(definition.extensions).toEqual(["a", "b"]);
		expect(definition.maxDepth).toBe(2);
		expect(() =>
			parseAgentDefinition("x", "/x.md", "user", "---\nmaxDepth: -2\n---\n"),
		).toThrow();
	});
});
