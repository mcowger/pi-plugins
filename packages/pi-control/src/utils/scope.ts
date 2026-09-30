/**
 * Deterministic scope classification for the `auto` action.
 *
 * `scope` asks where a call's effect lands relative to the cwd. Left to the
 * model, it guesses from raw text and treats any long absolute path as
 * suspicious, including the cwd itself. That makes it the most common source
 * of `uncertain-critical` asks. The call's targets are already resolved to
 * canonical absolute paths, so the plugin places them itself and the model's
 * answer is only used when no local path is known.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Scope labels the plugin can resolve from paths alone. */
export type CommandScope =
	| "within"
	| "temporary"
	| "outside"
	| "sensitive_system";

/**
 * What the caller knows about the call's local paths:
 * - `paths`: every target is known, so `scope` is resolved here.
 * - `none`: the call is fully static and names no local path, so there is no
 *   local effect to place. The model's `remote`/`not_applicable` stands, and an
 *   `unknown` collapses to `not_applicable`.
 *
 * `undefined` means the paths could not be determined (dynamic arguments, a
 * custom tool with no path field) and the model's answer is used unchanged.
 */
export type LocalScope =
	| { kind: "paths"; scope: CommandScope }
	| { kind: "none" };

/** How the final `scope` bucket was produced, recorded in the auto trace. */
export type ScopeSource = "deterministic" | "fallback" | "model";

/**
 * OS locations where any effect is sensitive regardless of cwd. `/dev` is
 * absent on purpose: `/dev/null` redirects are routine and `/dev/shm` is temp.
 */
const SENSITIVE_SYSTEM_ROOTS = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/sys",
	"/proc",
	"/var/lib",
	"/var/spool",
	"/System",
	"/Library",
	"/Windows",
];

/** Credential stores, relative to the home directory. */
const SENSITIVE_HOME_DIRS = [
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".docker",
	".password-store",
	".config/gcloud",
];

const SENSITIVE_BASENAMES = new Set([
	".env",
	".netrc",
	".npmrc",
	".pgpass",
	".git-credentials",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
]);

const SENSITIVE_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
];

/** Ephemeral space: transient by definition, so not an out-of-scope write. */
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/dev/shm"];

/** Character-device sinks. `> /dev/null` writes nothing to the filesystem. */
const SINK_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function isUnder(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isSinkPath(target: string): boolean {
	return SINK_PATHS.has(target) || target.startsWith("/dev/fd/");
}

/** A system location or credential store. */
export function isSensitiveSystemPath(
	target: string,
	home: string = homedir(),
): boolean {
	if (SENSITIVE_SYSTEM_ROOTS.some((root) => isUnder(target, root))) return true;
	if (SENSITIVE_HOME_DIRS.some((dir) => isUnder(target, join(home, dir)))) {
		return true;
	}
	const base = target.slice(target.lastIndexOf("/") + 1);
	if (SENSITIVE_BASENAMES.has(base)) return true;
	return SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

export function isTemporaryPath(target: string): boolean {
	return TEMP_ROOTS.some((root) => isUnder(target, root));
}

/** Place one absolute target relative to the cwd. */
export function classifyScope(
	target: string,
	cwd: string,
	home: string = homedir(),
): CommandScope {
	if (isSensitiveSystemPath(target, home)) return "sensitive_system";
	if (isUnder(target, cwd)) return "within";
	return isTemporaryPath(target) ? "temporary" : "outside";
}

/** Riskiest label wins, so one out-of-scope target cannot hide behind benign ones. */
const SCOPE_RANK: Record<CommandScope, number> = {
	within: 0,
	temporary: 1,
	outside: 2,
	sensitive_system: 3,
};

/**
 * Scope for a set of absolute targets, or `undefined` when none remain after
 * dropping device sinks.
 */
export function scopeFromTargets(
	targets: readonly string[],
	cwd: string,
	home: string = homedir(),
): CommandScope | undefined {
	let best: CommandScope | undefined;
	for (const target of targets) {
		if (isSinkPath(target)) continue;
		const label = classifyScope(target, cwd, home);
		if (best === undefined || SCOPE_RANK[label] > SCOPE_RANK[best]) {
			best = label;
		}
		if (best === "sensitive_system") break;
	}
	return best;
}

/** Build the caller-side scope fact from a call's explicit targets. */
export function localScopeFromTargets(
	targets: readonly string[],
	cwd: string,
	home: string = homedir(),
): LocalScope {
	const scope = scopeFromTargets(targets, cwd, home);
	return scope === undefined ? { kind: "none" } : { kind: "paths", scope };
}

/**
 * Combine the model's bucketed scope with what the plugin knows locally.
 */
export function resolveScope(
	modelScope: string,
	local: LocalScope | undefined,
): { scope: string; source: ScopeSource } {
	if (local?.kind === "paths") {
		return { scope: local.scope, source: "deterministic" };
	}
	if (local?.kind === "none" && modelScope === "unknown") {
		return { scope: "not_applicable", source: "fallback" };
	}
	return { scope: modelScope, source: "model" };
}
