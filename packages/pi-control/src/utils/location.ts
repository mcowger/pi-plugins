import { canonicalizePath } from "./path.js";
import type { ControlsResolvedConfig, Policy } from "../config.js";

export interface ResolvedPolicy {
	policy: Policy;
	name: string;
}

/**
 * Given a target path and the loaded config, return the applicable Policy
 * (most specific matching location wins). Returns null if no location matches
 * and there is no defaultPolicy.
 *
 * The target, the configured locations, and `$cwd` are all canonicalised
 * (symlinks resolved) so a link into a protected directory cannot inherit the
 * policy of the directory it appears to live in.
 */
export function resolvePolicy(
	targetPath: string,
	cwd: string,
	config: ControlsResolvedConfig,
): ResolvedPolicy | null {
	const normalTarget = canonicalizePath(targetPath, cwd);
	const normalCwd = canonicalizePath(cwd, cwd);

	let bestMatch: string | null = null;
	let bestPolicy: string | null = null;

	for (const [locationPath, policyName] of Object.entries(config.locations)) {
		// "$cwd" is a special key that resolves to the directory pi was started in.
		const normalLocation =
			locationPath === "$cwd" ? normalCwd : canonicalizePath(locationPath, cwd);

		// Target must be equal to or nested inside the location directory.
		if (
			normalTarget === normalLocation ||
			normalTarget.startsWith(`${normalLocation}/`)
		) {
			// Longest (most specific) location wins.
			if (bestMatch === null || normalLocation.length > bestMatch.length) {
				bestMatch = normalLocation;
				bestPolicy = policyName;
			}
		}
	}

	if (bestPolicy) {
		const policy = config.policies[bestPolicy];
		return policy ? { policy, name: bestPolicy } : null;
	}

	// Fall back to the global defaultPolicy.
	if (config.defaultPolicy) {
		const policy = config.policies[config.defaultPolicy];
		return policy ? { policy, name: config.defaultPolicy } : null;
	}

	return null;
}
