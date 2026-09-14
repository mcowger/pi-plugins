import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

/**
 * Read `enabledProviders` from pi's resolved settings.json.
 * Returns undefined if the field is absent or settings.json doesn't exist.
 */
export function readEnabledProviders(): string[] | undefined {
	if (!existsSync(SETTINGS_PATH)) {
		log("settings.json not found", { path: SETTINGS_PATH });
		return undefined;
	}

	try {
		const content = stripJsonComments(readFileSync(SETTINGS_PATH, "utf-8"));
		const parsed = JSON.parse(content) as Record<string, unknown>;

		if (Array.isArray(parsed.enabledProviders)) {
			return parsed.enabledProviders.filter((p): p is string => typeof p === "string");
		}

		log("enabledProviders not found or not an array in settings.json");
		return undefined;
	} catch (err) {
		log("error reading settings.json", { error: String(err) });
		return undefined;
	}
}

/** Strip // line comments and trailing commas (JSONC support) */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
