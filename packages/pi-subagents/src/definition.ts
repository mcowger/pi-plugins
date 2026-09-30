import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR_NAME, PROJECT_AGENTS_DIR } from "./constants.js";
import {
	type AgentDefinition,
	DEFAULT_AGENT_TOOLS,
	isLockableField,
	type LockableField,
	type LockDeclaration,
	type PromptMode,
} from "./types.js";

export interface DefinitionDiagnostic {
	path: string;
	message: string;
}

export interface DiscoveredDefinitions {
	definitions: Map<string, AgentDefinition>;
	diagnostics: DefinitionDiagnostic[];
}

interface RawFrontmatter {
	description?: unknown;
	display_name?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	max_turns?: unknown;
	timeout_minutes?: unknown;
	prompt_mode?: unknown;
	inherit_context?: unknown;
	run_in_background?: unknown;
	enabled?: unknown;
	locked?: unknown;
	extensions?: unknown;
	maxDepth?: unknown;
	[key: string]: unknown;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Parse a raw list field into items, or undefined if absent/empty/"none".
 * Accepts a comma-separated scalar or a YAML sequence.
 */
function parseListField(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const items = Array.isArray(value)
		? value.map((entry) => String(entry).trim()).filter(Boolean)
		: String(value)
				.trim()
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
	if (items.length === 0) return undefined;
	return items.length === 1 && items[0] === "none" ? undefined : items;
}

/** Omitted -> defaults; "none"/empty -> []; otherwise -> listed items. */
function listField(value: unknown, defaults: readonly string[]): string[] {
	if (value === undefined || value === null) return [...defaults];
	return parseListField(value) ?? [];
}

function parseLocked(value: unknown): LockDeclaration | undefined {
	if (typeof value === "boolean") return value ? true : undefined;
	const entries = parseListField(value);
	if (entries === undefined) return undefined;
	const fields = entries.filter(isLockableField) as LockableField[];
	return fields.length > 0 ? fields : undefined;
}

function parseMaxTurns(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return undefined;
	return Math.floor(value);
}

/** Minutes until a child is aborted; undefined or 0 disables the timeout. */
function parseTimeoutMinutes(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new Error("timeout_minutes must be a positive number of minutes");
	return value;
}

function parseMaxDepth(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		!Number.isFinite(value)
	) {
		throw new Error("maxDepth must be a finite non-negative integer");
	}
	return value;
}

/**
 * Parse one agent definition file. Pure so it can be tested without a filesystem.
 *
 * Follows the `@gotgenes/pi-subagents` frontmatter format: `description`,
 * `display_name`, `tools`, `model`, `thinking`, `max_turns`, `prompt_mode`,
 * `inherit_context`, `run_in_background`, `enabled`, and `locked`. `extensions`,
 * `maxDepth`, and `timeout_minutes` are local additions. Unknown keys are ignored.
 */
export function parseAgentDefinition(
	name: string,
	path: string,
	source: AgentDefinition["source"],
	content: string,
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter<RawFrontmatter>(content);
	const promptMode: PromptMode =
		frontmatter.prompt_mode === "replace" ? "replace" : "append";
	return Object.freeze({
		name,
		description: str(frontmatter.description) ?? name,
		displayName: str(frontmatter.display_name),
		path,
		source,
		tools: Object.freeze(listField(frontmatter.tools, DEFAULT_AGENT_TOOLS)),
		// A fuzzy or exact model string; resolution decides.
		model: str(frontmatter.model),
		// Thinking is validated against the resolved model's map at admission.
		thinking: str(frontmatter.thinking),
		maxTurns: parseMaxTurns(frontmatter.max_turns),
		timeoutMinutes: parseTimeoutMinutes(frontmatter.timeout_minutes),
		promptMode,
		inheritContext: parseBool(frontmatter.inherit_context),
		runInBackground: parseBool(frontmatter.run_in_background),
		locked: parseLocked(frontmatter.locked),
		extensions: parseListField(frontmatter.extensions),
		maxDepth: parseMaxDepth(frontmatter.maxDepth),
		instructions: body.trim(),
		enabled: frontmatter.enabled !== false,
	});
}

function listMarkdownFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const full = join(dir, entry);
		try {
			if (!statSync(full).isFile()) continue;
		} catch {
			continue;
		}
		files.push(full);
	}
	return files.sort();
}

function readDefinitionsFromDir(
	dir: string,
	source: AgentDefinition["source"],
	definitions: Map<string, AgentDefinition>,
	diagnostics: DefinitionDiagnostic[],
): void {
	for (const file of listMarkdownFiles(dir)) {
		const name = basename(file, ".md");
		try {
			const content = readFileSync(file, "utf8");
			const definition = parseAgentDefinition(name, file, source, content);
			if (!definition.enabled) continue;
			definitions.set(name, definition);
		} catch (error) {
			diagnostics.push({ path: file, message: (error as Error).message });
		}
	}
}

/**
 * Discover definitions. Trusted project `.pi/agents/` overrides the user
 * directory by name. Parse errors are reported and skipped; they never abort
 * discovery of other agents.
 */
export function discoverAgentDefinitions(options: {
	agentDir: string;
	cwd: string;
	trusted: boolean;
}): DiscoveredDefinitions {
	const definitions = new Map<string, AgentDefinition>();
	const diagnostics: DefinitionDiagnostic[] = [];

	readDefinitionsFromDir(
		join(options.agentDir, AGENTS_DIR_NAME),
		"user",
		definitions,
		diagnostics,
	);
	if (options.trusted) {
		readDefinitionsFromDir(
			join(options.cwd, PROJECT_AGENTS_DIR),
			"project",
			definitions,
			diagnostics,
		);
	}

	return { definitions, diagnostics };
}
