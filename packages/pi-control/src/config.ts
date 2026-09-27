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
	 * Optional policy name for an approval saved from an interactive prompt.
	 * Omitted rules apply to every policy; interactive approvals always set it.
	 */
	policy?: string;
}

/**
 * Fallback actions for eval classification edge cases. Narrower than
 * Action: only terminal enforcement outcomes make sense here.
 */
export type DecisionsFallbackAction = "allow" | "ask" | "deny";

export interface DecisionsWeights {
	destructive: number;
	obfuscated: number;
	network: number;
	exec: number;
	inferenceCall: number;
	writeSensitive: number;
	writeOutside: number;
	writeUnknown: number;
	readSensitive: number;
	readUnknown: number;
}

export interface DecisionsConfig {
	/** Full endpoint URL of the Decisions API. */
	url: string;
	/** Name of the env var holding the bearer token (never the token itself). */
	tokenEnv: string;
	/** Model requested from the Decisions router. */
	model: string;
	timeoutMs: number;
	maxSourceBytes: number;
	/** Action when eval shape is detected but source is not recoverable. */
	unavailableAction: DecisionsFallbackAction;
	/** Action on API/network/auth/timeout/malformed failure. */
	errorAction: DecisionsFallbackAction;
	/** noul p >= this → YES. */
	yesThreshold: number;
	/** noul p <= this → NO; between → UNCERTAIN. */
	noThreshold: number;
	/** choice P(top) >= this → confident label, else mass check. */
	choiceConfidence: number;
	/** Risky-label mass at/above this → UNCERTAIN (ask); below → top label. */
	riskyMassThreshold: number;
	/** Backstop score >= this → ask (the backstop never denies). */
	backstopThreshold: number;
	weights: DecisionsWeights;
}

export const DEFAULT_DECISIONS: DecisionsConfig = {
	url: "https://openrouter.ai/api/alpha/decisions",
	tokenEnv: "OPENROUTER_API_KEY",
	model: "typesafe/jev-1.13",
	timeoutMs: 15000,
	maxSourceBytes: 32768,
	unavailableAction: "ask",
	errorAction: "ask",
	yesThreshold: 0.7,
	noThreshold: 0.3,
	choiceConfidence: 0.6,
	riskyMassThreshold: 0.35,
	backstopThreshold: 40,
	weights: {
		destructive: 100,
		obfuscated: 40,
		network: 25,
		exec: 15,
		inferenceCall: 10,
		writeSensitive: 50,
		writeOutside: 30,
		writeUnknown: 20,
		readSensitive: 40,
		readUnknown: 20,
	},
};

function validCount(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function validWeight(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function validFallback(
	value: unknown,
	fallback: DecisionsFallbackAction,
): DecisionsFallbackAction {
	return value === "allow" || value === "ask" || value === "deny"
		? value
		: fallback;
}

/**
 * Resolve a raw (possibly partial) decisions block over the code defaults.
 * Returns null when absent or not an object — the feature stays off.
 * Invalid individual fields fall back to their defaults; the applied values
 * are always visible in the eval log trace.
 */
export function resolveDecisions(raw: unknown): DecisionsConfig | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	const defaults = structuredClone(DEFAULT_DECISIONS);

	const yesThreshold =
		typeof input.yesThreshold === "number" &&
		Number.isFinite(input.yesThreshold)
			? input.yesThreshold
			: defaults.yesThreshold;
	const noThreshold =
		typeof input.noThreshold === "number" && Number.isFinite(input.noThreshold)
			? input.noThreshold
			: defaults.noThreshold;
	const thresholdsValid =
		yesThreshold > noThreshold && noThreshold >= 0 && yesThreshold <= 1;
	const choiceConfidence =
		typeof input.choiceConfidence === "number" &&
		Number.isFinite(input.choiceConfidence) &&
		input.choiceConfidence > 0 &&
		input.choiceConfidence <= 1
			? input.choiceConfidence
			: defaults.choiceConfidence;
	const riskyMassThreshold =
		typeof input.riskyMassThreshold === "number" &&
		Number.isFinite(input.riskyMassThreshold) &&
		input.riskyMassThreshold > 0 &&
		input.riskyMassThreshold <= 1
			? input.riskyMassThreshold
			: defaults.riskyMassThreshold;

	const rawWeights =
		input.weights !== null && typeof input.weights === "object"
			? (input.weights as Record<string, unknown>)
			: {};
	const weights: DecisionsWeights = {
		destructive: validWeight(
			rawWeights.destructive,
			defaults.weights.destructive,
		),
		obfuscated: validWeight(rawWeights.obfuscated, defaults.weights.obfuscated),
		network: validWeight(rawWeights.network, defaults.weights.network),
		exec: validWeight(rawWeights.exec, defaults.weights.exec),
		inferenceCall: validWeight(
			rawWeights.inferenceCall,
			defaults.weights.inferenceCall,
		),
		writeSensitive: validWeight(
			rawWeights.writeSensitive,
			defaults.weights.writeSensitive,
		),
		writeOutside: validWeight(
			rawWeights.writeOutside,
			defaults.weights.writeOutside,
		),
		writeUnknown: validWeight(
			rawWeights.writeUnknown,
			defaults.weights.writeUnknown,
		),
		readSensitive: validWeight(
			rawWeights.readSensitive,
			defaults.weights.readSensitive,
		),
		readUnknown: validWeight(
			rawWeights.readUnknown,
			defaults.weights.readUnknown,
		),
	};

	return {
		url:
			typeof input.url === "string" && input.url.length > 0
				? input.url
				: defaults.url,
		tokenEnv:
			typeof input.tokenEnv === "string" && input.tokenEnv.length > 0
				? input.tokenEnv
				: defaults.tokenEnv,
		model:
			typeof input.model === "string" && input.model.length > 0
				? input.model
				: defaults.model,
		timeoutMs: validCount(input.timeoutMs, defaults.timeoutMs),
		maxSourceBytes: validCount(input.maxSourceBytes, defaults.maxSourceBytes),
		unavailableAction: validFallback(
			input.unavailableAction,
			defaults.unavailableAction,
		),
		errorAction: validFallback(input.errorAction, defaults.errorAction),
		yesThreshold: thresholdsValid ? yesThreshold : defaults.yesThreshold,
		noThreshold: thresholdsValid ? noThreshold : defaults.noThreshold,
		choiceConfidence,
		riskyMassThreshold,
		backstopThreshold: validCount(
			input.backstopThreshold,
			defaults.backstopThreshold,
		),
		weights,
	};
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
	/**
	 * Optional eval classification via the Decisions API. Absent/null =
	 * feature off: bash enforcement is location policy only.
	 */
	decisions?: DecisionsConfig | null;
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
	decisions: DecisionsConfig | null;
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
	decisions: null,
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
			// decisions resolves code defaults over the deep-merged block
			// (global → local), so partial blocks and single-weight
			// overrides work.
			decisions: resolveDecisions(raw.decisions),
		};
	}

	getConfig(): ControlsResolvedConfig {
		return this.resolved;
	}
}

export function createConfigLoader(): ControlsConfigLoader {
	return new ControlsConfigLoader();
}
