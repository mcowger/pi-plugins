import { normalizePath } from "./path.js";
import type { ControlsResolvedConfig, Policy } from "../config.js";

export interface ResolvedPolicy {
	policy: Policy;
	name: string;
}

/**
 * Given a target path and the loaded config, return the applicable Policy
 * (most specific matching location wins). Returns null if no location matches
 * and there is no defaultPolicy.
 */
export function resolvePolicy(
	targetPath: string,
	cwd: string,
	config: ControlsResolvedConfig,
): ResolvedPolicy | null {
	const normalTarget = normalizePath(targetPath, cwd);

	let bestMatch: string | null = null;

	for (const locationPath of Object.keys(config.locations)) {
		// "$cwd" is a special key that resolves to the directory pi was started in.
		const normalLocation =
			locationPath === "$cwd" ? cwd : normalizePath(locationPath, cwd);

		// Target must be equal to or nested inside the location directory.
		if (
			normalTarget === normalLocation ||
			normalTarget.startsWith(`${normalLocation}/`)
		) {
			// Longest (most specific) location wins.
			if (bestMatch === null || normalLocation.length > bestMatch.length) {
				bestMatch = normalLocation;
				// Store normalised key so we can look up the policy name.
				// Re-map: find the original key that normalises to bestMatch.
			}
		}
	}

	// Look up the original key whose normalised form equals bestMatch.
	const policyName = bestMatch
		? (() => {
				for (const [k, v] of Object.entries(config.locations)) {
					const normalK = k === "$cwd" ? cwd : normalizePath(k, cwd);
					if (normalK === bestMatch) return v;
				}
				return null;
			})()
		: null;

	if (policyName) {
		const policy = config.policies[policyName];
		return policy ? { policy, name: policyName } : null;
	}

	// Fall back to the global defaultPolicy.
	if (config.defaultPolicy) {
		const policy = config.policies[config.defaultPolicy];
		return policy ? { policy, name: config.defaultPolicy } : null;
	}

	return null;
}
