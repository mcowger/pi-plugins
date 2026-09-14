/**
 * Config schema and JSONC loader for pi-controls.
 *
 * Config file: pi-controls.jsonc  (falls back to pi-controls.json)
 * Global:  getAgentDir()/extensions/pi-controls.jsonc
 * Local:   .pi/extensions/pi-controls.jsonc  (walks up from CWD)
 *
 * Local definitions win on conflict (deep merge: global → local).
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SAFE_BASH_PATTERNS } from "./utils/safe-commands.js";

// ─── Schema types ─────────────────────────────────────────────────────────────

export type Action = "allow" | "ask" | "deny" | "log" | "nudge";

export interface Rule {
	action: Action;
	tool: string;
	pattern?: string; // bash only
	/** Required when action is "nudge": the reminder message injected into the tool result. */
	message?: string;
	/**
	 * Permit a matching `allow` Bash rule to bypass the fallback action for
	 * interpreter source that cannot be statically analyzed. Use only for a
	 * command pattern whose source execution you explicitly trust.
	 */
	allowUnanalyzed?: boolean;
	/**
	 * Optional policy name for an approval saved from an interactive prompt.
	 * Omitted rules apply to every policy; interactive approvals always set it.
	 */
	policy?: string;
}

export interface Policy {
	defaultAction: Action;
	rules: Rule[];
}

// ─── Preset expansion ─────────────────────────────────────────────────────────
//
// A rule with pattern "$safe-bash" expands to one allow rule per safe command.
// Example: { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }

const PATTERN_PRESETS: Record<string, string[]> = {
	"$safe-bash": SAFE_BASH_PATTERNS,
};

function expandRules(rules: Rule[]): Rule[] {
	return rules.flatMap((rule) => {
		if (rule.pattern && rule.pattern in PATTERN_PRESETS) {
			return PATTERN_PRESETS[rule.pattern].map((pattern) => ({
				...rule,
				pattern,
			}));
		}
		return [rule];
	});
}

function expandPolicies(
	policies: Record<string, Policy>,
): Record<string, Policy> {
	const expanded: Record<string, Policy> = {};
	for (const [name, policy] of Object.entries(policies)) {
		expanded[name] = { ...policy, rules: expandRules(policy.rules) };
	}
	return expanded;
}

/**
 * Configures automatic deny→ask escalation when the agent is denied too many
 * times in a rolling window (the "rogue agent" circuit breaker).
 *
 * When the agent accumulates `maxDenies` denied tool calls within
 * `windowSeconds` seconds, the *next* denied call is escalated from an
 * automatic "deny" to an interactive "ask", giving the user a chance to step
 * in and redirect the agent.
 *
 * The window is sliding: only denies within the last `windowSeconds` seconds
 * count. The escalation resets as soon as the window empties.
 */
export interface AgentTimeout {
	/** Number of denied calls within `windowSeconds` that triggers escalation. */
	maxDenies: number;
	/** Rolling window size in seconds. */
	windowSeconds: number;
}

/**
 * Configures automatic nudge→deny escalation when the agent ignores nudges
 * too many times for the same rule in a rolling window.
 *
 * When the same nudge rule fires `maxNudges` times within `windowSeconds`
 * seconds, the next occurrence is escalated to a hard deny with a strong
 * message demanding the agent change its approach. The per-rule counter resets
 * after escalation.
 */
export interface NudgeTimeout {
	/** Number of nudges for the same rule within `windowSeconds` that triggers escalation. */
	maxNudges: number;
	/** Rolling window size in seconds. */
	windowSeconds: number;
}

export interface InterpreterAnalysisConfig {
	/** Enable analysis of source supplied to Python, Node, Bun, and shell wrappers. */
	enabled: boolean;
	/** Conservative action when analysis cannot prove all effects and targets. */
	unknownAction: "ask" | "deny";
	/** Maximum embedded source size accepted for analysis. */
	maxSourceBytes: number;
	/** Maximum nested shell-wrapper depth. */
	maxDepth: number;
	/** Maximum syntax-tree nodes visited per source. */
	maxNodes: number;
}

export interface ControlsConfig {
	policies?: Record<string, Policy>;
	locations?: Record<string, string>;
	/**
	 * Allow rules saved interactively from a pi-controls confirmation prompt.
	 * Global and project-local lists are combined at load time; these rules take
	 * precedence over location-policy rules, but never pathProtection.
	 */
	approvalRules?: Rule[];
	/**
	 * Fallback policy name when no location matches.
	 * null / absent = fail-open (all tool calls proceed unrestricted).
	 */
	defaultPolicy?: string | null;
	/**
	 * Keyboard shortcut for cycling through enforce → ignore → inform modes.
	 * Must be a valid pi KeyId string (e.g. "ctrl+shift+m", "alt+p").
	 * Defaults to "ctrl+shift+m" when absent.
	 */
	cycleKey?: string;
	/**
	 * Optional circuit-breaker: escalate deny→ask when the agent is denied
	 * too many times in a rolling window.
	 */
	agentTimeout?: AgentTimeout | null;
	/**
	 * Optional circuit-breaker: escalate nudge→deny when the agent ignores
	 * the same nudge rule too many times in a rolling window.
	 */
	nudgeTimeout?: NudgeTimeout | null;
	/**
	 * Cross-cutting path protection — patterns matched against file paths
	 * BEFORE location-based policies. A "deny" here blocks the tool call
	 * regardless of which tool is used (read, write, edit, bash, etc.).
	 *
	 * Patterns use minimatch globs (e.g. "*.env", "~/.ssh/*", "**&#47;secrets/**").
	 * This is the correct place to protect sensitive files from ALL tools.
	 */
	pathProtection?: Record<string, Action> | null;
	/** Conservative static analysis for source hidden in interpreter invocations. */
	interpreterAnalysis?: Partial<InterpreterAnalysisConfig> | null;
}

export interface ControlsResolvedConfig {
	policies: Record<string, Policy>;
	locations: Record<string, string>;
	/** Persisted allow rules from global and project-local configuration. */
	approvalRules?: Rule[];
	defaultPolicy: string | null;
	cycleKey: string;
	agentTimeout: AgentTimeout | null;
	nudgeTimeout: NudgeTimeout | null;
	pathProtection: Record<string, Action> | null;
	/** Optional here so hand-built configs remain source compatible; the loader always supplies defaults. */
	interpreterAnalysis?: InterpreterAnalysisConfig | null;
}

export const DEFAULT_INTERPRETER_ANALYSIS: InterpreterAnalysisConfig = {
	enabled: true,
	unknownAction: "ask",
	maxSourceBytes: 256 * 1024,
	maxDepth: 4,
	maxNodes: 10_000,
};

function resolveInterpreterAnalysis(
	value: Partial<InterpreterAnalysisConfig> | null | undefined,
): InterpreterAnalysisConfig | null {
	if (value === null) return null;
	return {
		enabled: value?.enabled !== false,
		unknownAction: value?.unknownAction === "deny" ? "deny" : "ask",
		maxSourceBytes:
			typeof value?.maxSourceBytes === "number" && value.maxSourceBytes > 0
				? value.maxSourceBytes
				: DEFAULT_INTERPRETER_ANALYSIS.maxSourceBytes,
		maxDepth:
			typeof value?.maxDepth === "number" && value.maxDepth >= 0
				? value.maxDepth
				: DEFAULT_INTERPRETER_ANALYSIS.maxDepth,
		maxNodes:
			typeof value?.maxNodes === "number" && value.maxNodes > 0
				? value.maxNodes
				: DEFAULT_INTERPRETER_ANALYSIS.maxNodes,
	};
}

const DEFAULTS: ControlsResolvedConfig = {
	policies: {},
	locations: {},
	approvalRules: [],
	defaultPolicy: null,
	cycleKey: "ctrl+shift+m",
	agentTimeout: null,
	nudgeTimeout: null,
	pathProtection: null,
	interpreterAnalysis: DEFAULT_INTERPRETER_ANALYSIS,
};

// ─── File discovery ───────────────────────────────────────────────────────────

const FILENAMES = ["pi-controls.jsonc", "pi-controls.json"];

export function findGlobalConfigPath(): string {
	const base = resolve(getAgentDir(), "extensions");
	for (const name of FILENAMES) {
		const p = resolve(base, name);
		if (existsSync(p)) return p;
	}
	// Default to .jsonc for new files.
	return resolve(base, "pi-controls.jsonc");
}

export function findProjectConfigPath(startDir = process.cwd()): string {
	let dir = startDir;
	const home = homedir();
	while (true) {
		if (dir === home) break;
		for (const dirName of [".pi"]) {
			const piDir = resolve(dir, dirName);
			if (existsSync(piDir) && statSync(piDir).isDirectory()) {
				for (const name of FILENAMES) {
					const p = resolve(piDir, `extensions/${name}`);
					if (existsSync(p)) return p;
				}
				// Not found yet — return the canonical .jsonc path for writes.
				return resolve(piDir, "extensions/pi-controls.jsonc");
			}
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	// No project config exists yet. Use the current directory as the project
	// root so an interactive approval can create one predictably.
	return resolve(startDir, ".pi/extensions/pi-controls.jsonc");
}

/** Read a JSONC file without exposing parsing failures as an empty config. */
async function readConfigFile(path: string): Promise<{
	raw: string;
	config: ControlsConfig;
} | null> {
	try {
		const raw = await readFile(path, "utf-8");
		return {
			raw,
			config: JSON.parse(stripJsonComments(raw)) as ControlsConfig,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		throw new Error(`Unable to read pi-controls config ${path}: ${error}`);
	}
}

function formatApprovalRules(rules: Rule[], propertyIndent: string): string {
	return JSON.stringify(rules, null, "\t")
		.split("\n")
		.map((line, index) => (index === 0 ? line : `${propertyIndent}${line}`))
		.join("\n");
}

/** Find the closing bracket for an array, ignoring strings and comments. */
function findArrayEnd(source: string, start: number): number {
	let depth = 0;
	let quote: '"' | "'" | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote) {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "[") depth++;
		if (char === "]") {
			depth--;
			if (depth === 0) return index;
		}
	}
	throw new Error(
		"Could not find the end of approvalRules in pi-controls config",
	);
}

function updateApprovalRules(raw: string, rules: Rule[]): string {
	const property = /^(\s*)"approvalRules"\s*:\s*\[/m.exec(raw);
	if (property?.index !== undefined) {
		const indent = property[1];
		const valueStart = raw.indexOf(
			"[",
			property.index + property[0].length - 1,
		);
		const valueEnd = findArrayEnd(raw, valueStart);
		return (
			raw.slice(0, valueStart) +
			formatApprovalRules(rules, indent) +
			raw.slice(valueEnd + 1)
		);
	}

	if (raw.trim().length === 0) {
		return `{\n\t"approvalRules": ${formatApprovalRules(rules, "\t")}\n}\n`;
	}
	const close = raw.lastIndexOf("}");
	if (close === -1) {
		throw new Error("pi-controls config is not a JSONC object");
	}
	const before = raw.slice(0, close).trimEnd();
	const needsComma = before.trim() !== "{";
	return `${before}${needsComma ? "," : ""}\n\t"approvalRules": ${formatApprovalRules(rules, "\t")}\n}${raw.slice(close + 1)}`;
}

/**
 * Add an interactive allow rule without rewriting unrelated JSONC comments.
 * Returns the config path and whether an identical rule already existed.
 */
export async function addApprovalRule(
	scope: "project" | "global",
	cwd: string,
	rule: Rule,
): Promise<{ path: string; added: boolean }> {
	const path =
		scope === "global" ? findGlobalConfigPath() : findProjectConfigPath(cwd);
	const existing = await readConfigFile(path);
	const config = existing?.config ?? {};
	const rules = config.approvalRules ?? [];
	if (
		rules.some(
			(existingRule) =>
				existingRule.action === rule.action &&
				existingRule.tool === rule.tool &&
				existingRule.pattern === rule.pattern &&
				existingRule.policy === rule.policy,
		)
	) {
		return { path, added: false };
	}
	const nextRules = [...rules, rule];
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		updateApprovalRules(existing?.raw ?? "", nextRules),
		"utf-8",
	);
	return { path, added: true };
}

// ─── Deep merge ───────────────────────────────────────────────────────────────

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const key of Object.keys(source)) {
		const sv = source[key];
		if (sv === undefined) continue;
		if (sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
			if (!target[key] || typeof target[key] !== "object") target[key] = {};
			deepMerge(
				target[key] as Record<string, unknown>,
				sv as Record<string, unknown>,
			);
		} else {
			target[key] = sv;
		}
	}
}

// ─── Loader ───────────────────────────────────────────────────────────────────

async function readJsonc(path: string): Promise<ControlsConfig | null> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(stripJsonComments(raw)) as ControlsConfig;
	} catch {
		return null;
	}
}

export class ControlsConfigLoader {
	private resolved: ControlsResolvedConfig = structuredClone(DEFAULTS);

	async load(): Promise<void> {
		const merged = structuredClone(DEFAULTS) as unknown as Record<
			string,
			unknown
		>;

		const globalCfg = await readJsonc(findGlobalConfigPath());
		if (globalCfg) deepMerge(merged, globalCfg as Record<string, unknown>);

		const localCfg = await readJsonc(findProjectConfigPath());
		if (localCfg) deepMerge(merged, localCfg as Record<string, unknown>);

		const raw = merged as unknown as ControlsResolvedConfig;
		this.resolved = {
			...raw,
			// approvalRules are additive: project approvals must not hide globally
			// approved commands when the project config is loaded.
			approvalRules: [
				...(globalCfg?.approvalRules ?? []),
				...(localCfg?.approvalRules ?? []),
			],
			policies: expandPolicies(raw.policies),
			interpreterAnalysis: resolveInterpreterAnalysis(raw.interpreterAnalysis),
		};
	}

	getConfig(): ControlsResolvedConfig {
		return this.resolved;
	}
}

export function createConfigLoader(): ControlsConfigLoader {
	return new ControlsConfigLoader();
}
