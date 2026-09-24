import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS, OWN_TOOL_NAMES, SLUG_PATTERN, THINKING_LEVELS } from "./constants.ts";
import type { AgentDefinition, AgentLoadResult, ExtensionsSpec, SkillsSpec } from "./types.ts";

const KNOWN_FIELDS = new Set([
	"description",
	"display_name",
	"tools",
	"exclude_tools",
	"extensions",
	"exclude_extensions",
	"skills",
	"context_files",
	"system_prompt_mode",
	"model",
	"thinking",
	"allow_model_override",
	"max_turns",
]);

function parseStringList(
	value: unknown,
	field: string,
	{ trim, dedupe }: { trim: boolean; dedupe: boolean },
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		if (field === "tools") throw new Error("tools must be a list of tool names");
		throw new Error(`${field} must be a list of strings`);
	}

	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.trim() === "") {
			throw new Error(`${field} must be a list of non-empty strings`);
		}
		const entry = trim ? item.trim() : item;
		if (dedupe && result.includes(entry)) continue;
		result.push(entry);
	}
	return result;
}

function parseSpec(value: unknown, field: string): "none" | "all" | string[] | undefined {
	if (value === undefined) return undefined;
	if (value === "none" || value === "all") return value;
	if (Array.isArray(value)) {
		return value.map((item) => {
			if (typeof item !== "string" || item.trim() === "") {
				throw new Error(`${field} must be "none", "all", or a list of strings`);
			}
			return item;
		});
	}
	throw new Error(`${field} must be "none", "all", or a list of strings`);
}

export function parseAgentFile(filePath: string, content: string, source: "user" | "project"): AgentDefinition {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid YAML frontmatter: ${message}`);
	}

	for (const key of Object.keys(frontmatter)) {
		if (!KNOWN_FIELDS.has(key)) {
			throw new Error(`unknown field '${key}'`);
		}
	}

	const rawDescription = frontmatter.description;
	if (typeof rawDescription !== "string" || rawDescription.trim() === "") {
		throw new Error("description is required and must be a non-empty string");
	}
	const description = rawDescription.trim().replace(/\s+/g, " ");

	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const slug = base.endsWith(".md") ? base.slice(0, -3) : base;

	let displayName = slug;
	if (frontmatter.display_name !== undefined) {
		if (typeof frontmatter.display_name !== "string" || frontmatter.display_name.trim() === "") {
			throw new Error("display_name must be a non-empty string");
		}
		displayName = frontmatter.display_name;
	}

	const tools = parseStringList(frontmatter.tools, "tools", { trim: true, dedupe: true }) ?? [...DEFAULT_TOOLS];
	for (const tool of tools) {
		if ((OWN_TOOL_NAMES as readonly string[]).includes(tool)) {
			throw new Error(`sub-agents cannot use '${tool}'`);
		}
	}

	const excludeTools = parseStringList(frontmatter.exclude_tools, "exclude_tools", { trim: true, dedupe: false }) ?? [];

	const extensions = (parseSpec(frontmatter.extensions, "extensions") ?? "none") as ExtensionsSpec;

	if (frontmatter.exclude_extensions !== undefined && extensions !== "all") {
		throw new Error("exclude_extensions requires extensions: all");
	}
	const excludeExtensions =
		parseStringList(frontmatter.exclude_extensions, "exclude_extensions", { trim: true, dedupe: false }) ?? [];

	const skills = (parseSpec(frontmatter.skills, "skills") ?? "none") as SkillsSpec;

	let contextFiles = false;
	if (frontmatter.context_files !== undefined) {
		if (typeof frontmatter.context_files !== "boolean") {
			throw new Error("context_files must be a boolean");
		}
		contextFiles = frontmatter.context_files;
	}

	let systemPromptMode: "append" | "replace" = "append";
	if (frontmatter.system_prompt_mode !== undefined) {
		if (frontmatter.system_prompt_mode !== "append" && frontmatter.system_prompt_mode !== "replace") {
			throw new Error('system_prompt_mode must be "append" or "replace"');
		}
		systemPromptMode = frontmatter.system_prompt_mode;
	}

	let model: string | undefined;
	if (frontmatter.model !== undefined) {
		if (typeof frontmatter.model !== "string") {
			throw new Error("model must be a string");
		}
		const slashIndex = frontmatter.model.indexOf("/");
		if (slashIndex <= 0 || slashIndex === frontmatter.model.length - 1) {
			throw new Error("model must be in the form 'provider/modelId'");
		}
		model = frontmatter.model;
	}

	let thinking: ThinkingLevel | undefined;
	if (frontmatter.thinking !== undefined) {
		if (
			typeof frontmatter.thinking !== "string" ||
			!(THINKING_LEVELS as readonly string[]).includes(frontmatter.thinking)
		) {
			throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
		thinking = frontmatter.thinking as ThinkingLevel;
	}

	let allowModelOverride = false;
	if (frontmatter.allow_model_override !== undefined) {
		if (typeof frontmatter.allow_model_override !== "boolean") {
			throw new Error("allow_model_override must be a boolean");
		}
		allowModelOverride = frontmatter.allow_model_override;
	}

	let maxTurns: number | undefined;
	if (frontmatter.max_turns !== undefined) {
		if (
			typeof frontmatter.max_turns !== "number" ||
			!Number.isInteger(frontmatter.max_turns) ||
			frontmatter.max_turns < 1
		) {
			throw new Error("max_turns must be a positive integer");
		}
		maxTurns = frontmatter.max_turns;
	}

	return {
		slug,
		displayName,
		description,
		body: body.trim(),
		tools,
		excludeTools,
		extensions,
		excludeExtensions,
		skills,
		contextFiles,
		systemPromptMode,
		model,
		thinking,
		allowModelOverride,
		maxTurns,
		source,
		filePath,
	};
}

export function loadAgents(cwd: string, agentDir: string): AgentLoadResult {
	const errors: Array<{ filePath: string; message: string }> = [];
	const bySlug = new Map<string, AgentDefinition>();

	const searchDirs: Array<{ dir: string; source: "user" | "project" }> = [
		{ dir: join(agentDir, "agents"), source: "user" },
		{ dir: join(cwd, ".pi", "agents"), source: "project" },
	];

	for (const { dir, source } of searchDirs) {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) {
				continue;
			}

			const filePath = join(dir, entry.name);
			const slug = entry.name.slice(0, -3);
			if (!SLUG_PATTERN.test(slug)) {
				errors.push({
					filePath,
					message: `invalid agent file name '${entry.name}': slug must match ${SLUG_PATTERN.source}`,
				});
				continue;
			}

			try {
				const content = readFileSync(filePath, "utf-8");
				const agent = parseAgentFile(filePath, content, source);
				bySlug.set(slug, agent);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({ filePath, message });
			}
		}
	}

	const agents = [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return { agents, errors };
}
