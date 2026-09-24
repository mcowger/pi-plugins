import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, parseAgentFile } from "../src/agents.ts";
import { DEFAULT_TOOLS } from "../src/constants.ts";

function agentFile(frontmatter: string, body = "Do the thing."): string {
	return `---\n${frontmatter}\n---\n${body}\n`;
}

const FILE_PATH = "/tmp/agents/scout.md";

describe("parseAgentFile", () => {
	it("uses documented defaults for a minimal valid file", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "Find things"'), "user");
		expect(agent).toEqual({
			slug: "scout",
			displayName: "scout",
			description: "Find things",
			body: "Do the thing.",
			tools: [...DEFAULT_TOOLS],
			excludeTools: [],
			extensions: "none",
			excludeExtensions: [],
			skills: "none",
			contextFiles: false,
			systemPromptMode: "append",
			model: undefined,
			thinking: undefined,
			allowModelOverride: false,
			maxTurns: undefined,
			source: "user",
			filePath: FILE_PATH,
		});
	});

	it("requires a non-empty description", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('display_name: "X"'), "user")).toThrow(/description/);
	});

	it("collapses whitespace runs in the description", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "Line one\\n  extra   spaces"'), "user");
		expect(agent.description).toBe("Line one extra spaces");
	});

	it("accepts display_name and defaults to the slug otherwise", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\ndisplay_name: "Scout Agent"'), "user");
		expect(agent.displayName).toBe("Scout Agent");
	});

	it("rejects an empty display_name", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\ndisplay_name: ""'), "user")).toThrow(
			/display_name/,
		);
	});

	it("accepts a tools list, trimmed and deduped", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\ntools: [" read", "grep", "read"]'), "user");
		expect(agent.tools).toEqual(["read", "grep"]);
	});

	it("allows an empty tools list (no tools)", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\ntools: []'), "user");
		expect(agent.tools).toEqual([]);
	});

	it("rejects tools: true (regression for the pi-subagents-lite bug)", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\ntools: true'), "user")).toThrow(
			"tools must be a list of tool names",
		);
	});

	it("rejects tools: 'read' (a bare string, not a list)", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\ntools: "read"'), "user")).toThrow(
			"tools must be a list of tool names",
		);
	});

	it("rejects our own tool names in tools", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\ntools: ["agent"]'), "user")).toThrow(
			"sub-agents cannot use 'agent'",
		);
	});

	it("accepts exclude_tools", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nexclude_tools: ["write"]'), "user");
		expect(agent.excludeTools).toEqual(["write"]);
	});

	it("rejects a non-list exclude_tools", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nexclude_tools: "write"'), "user")).toThrow();
	});

	it("accepts extensions: all", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nextensions: all'), "user");
		expect(agent.extensions).toBe("all");
	});

	it("accepts an extensions list", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nextensions: ["foo"]'), "user");
		expect(agent.extensions).toEqual(["foo"]);
	});

	it("rejects an invalid extensions value", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nextensions: "sometimes"'), "user")).toThrow();
	});

	it("accepts exclude_extensions when extensions: all", () => {
		const agent = parseAgentFile(
			FILE_PATH,
			agentFile('description: "d"\nextensions: all\nexclude_extensions: ["bar"]'),
			"user",
		);
		expect(agent.excludeExtensions).toEqual(["bar"]);
	});

	it("rejects exclude_extensions without extensions: all", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nexclude_extensions: ["bar"]'), "user")).toThrow(
			"exclude_extensions requires extensions: all",
		);
	});

	it("accepts skills: all", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nskills: all'), "user");
		expect(agent.skills).toBe("all");
	});

	it("rejects an invalid skills value", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nskills: 5'), "user")).toThrow();
	});

	it("accepts context_files: true", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\ncontext_files: true'), "user");
		expect(agent.contextFiles).toBe(true);
	});

	it("rejects a non-boolean context_files", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\ncontext_files: "yes"'), "user")).toThrow();
	});

	it("accepts system_prompt_mode: replace", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nsystem_prompt_mode: replace'), "user");
		expect(agent.systemPromptMode).toBe("replace");
	});

	it("rejects an invalid system_prompt_mode", () => {
		expect(() =>
			parseAgentFile(FILE_PATH, agentFile('description: "d"\nsystem_prompt_mode: overwrite'), "user"),
		).toThrow();
	});

	it("accepts a provider/modelId model", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nmodel: "anthropic/claude-haiku-4-5"'), "user");
		expect(agent.model).toBe("anthropic/claude-haiku-4-5");
	});

	it("rejects a model without a slash", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nmodel: "nosolidus"'), "user")).toThrow();
	});

	it("accepts a valid thinking level", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nthinking: high'), "user");
		expect(agent.thinking).toBe("high");
	});

	it("rejects an invalid thinking level", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nthinking: extreme'), "user")).toThrow();
	});

	it("accepts allow_model_override: true", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nallow_model_override: true'), "user");
		expect(agent.allowModelOverride).toBe(true);
	});

	it("rejects a non-boolean allow_model_override", () => {
		expect(() =>
			parseAgentFile(FILE_PATH, agentFile('description: "d"\nallow_model_override: "yes"'), "user"),
		).toThrow();
	});

	it("accepts a positive integer max_turns", () => {
		const agent = parseAgentFile(FILE_PATH, agentFile('description: "d"\nmax_turns: 12'), "user");
		expect(agent.maxTurns).toBe(12);
	});

	it("rejects max_turns: 0", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nmax_turns: 0'), "user")).toThrow();
	});

	it("rejects unknown fields", () => {
		expect(() => parseAgentFile(FILE_PATH, agentFile('description: "d"\nfoo: bar'), "user")).toThrow(
			"unknown field 'foo'",
		);
	});

	it("wraps malformed YAML frontmatter errors", () => {
		const badContent = "---\ndescription: [oops\n---\nbody\n";
		expect(() => parseAgentFile(FILE_PATH, badContent, "user")).toThrow(/invalid YAML frontmatter/);
	});
});

describe("loadAgents", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function tempDirs(): Promise<{ agentDir: string; cwd: string }> {
		const agentDir = await mkdtemp(join(tmpdir(), "super-agents-pi-agentdir-"));
		const cwd = await mkdtemp(join(tmpdir(), "super-agents-pi-cwd-"));
		createdDirs.push(agentDir, cwd);
		return { agentDir, cwd };
	}

	it("returns nothing when neither directory exists", async () => {
		const { agentDir, cwd } = await tempDirs();
		expect(loadAgents(cwd, agentDir)).toEqual({ agents: [], errors: [] });
	});

	it("discovers user and project agents; project overrides user on the same slug; sorted by slug", async () => {
		const { agentDir, cwd } = await tempDirs();
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(join(agentDir, "agents", "scout.md"), agentFile('description: "User scout"'));
		await writeFile(join(agentDir, "agents", "writer.md"), agentFile('description: "Writer"'));
		await writeFile(join(cwd, ".pi", "agents", "scout.md"), agentFile('description: "Project scout"'));

		const result = loadAgents(cwd, agentDir);

		expect(result.errors).toEqual([]);
		expect(result.agents.map((a) => a.slug)).toEqual(["scout", "writer"]);
		const scout = result.agents.find((a) => a.slug === "scout");
		expect(scout?.description).toBe("Project scout");
		expect(scout?.source).toBe("project");
	});

	it("records an error for a bad file without blocking other files from loading", async () => {
		const { agentDir, cwd } = await tempDirs();
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(join(agentDir, "agents", "bad.md"), agentFile('description: "d"\nfoo: bar'));
		await writeFile(join(agentDir, "agents", "good.md"), agentFile('description: "Good agent"'));

		const result = loadAgents(cwd, agentDir);

		expect(result.agents.map((a) => a.slug)).toEqual(["good"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain("unknown field 'foo'");
	});

	it("ignores subdirectories, dotfiles, and non-.md files; rejects invalid slug filenames", async () => {
		const { agentDir, cwd } = await tempDirs();
		const agentsDir = join(agentDir, "agents");
		await mkdir(join(agentsDir, "subdir"), { recursive: true });
		await writeFile(join(agentsDir, "subdir", "nested.md"), agentFile('description: "nested"'));
		await writeFile(join(agentsDir, "notes.txt"), "hello");
		await writeFile(join(agentsDir, ".hidden.md"), agentFile('description: "hidden"'));
		await writeFile(join(agentsDir, "Bad Slug.md"), agentFile('description: "bad"'));

		const result = loadAgents(cwd, agentDir);

		expect(result.agents).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.message).toContain("invalid agent file name");
	});
});
