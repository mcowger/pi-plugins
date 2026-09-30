import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_MAX_DEPTH } from "./constants.js";
import type { OperatorConfig } from "./types.js";

export class SubagentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentConfigError";
	}
}

export function defaultOperatorConfig(): OperatorConfig {
	return {
		maxDepth: DEFAULT_MAX_DEPTH,
		approvedExtensions: {},
		excludedExtensions: [],
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate operator config. A finite integer `maxDepth` is required; there is no
 * unbounded mode (spec section 6).
 */
export function parseOperatorConfig(raw: unknown): OperatorConfig {
	if (raw === undefined || raw === null) return defaultOperatorConfig();
	if (!isPlainObject(raw)) {
		throw new SubagentConfigError("operator config must be a JSON object");
	}

	let maxDepth = DEFAULT_MAX_DEPTH;
	if (raw.maxDepth !== undefined) {
		if (
			typeof raw.maxDepth !== "number" ||
			!Number.isInteger(raw.maxDepth) ||
			raw.maxDepth < 0 ||
			!Number.isFinite(raw.maxDepth)
		) {
			throw new SubagentConfigError(
				"maxDepth must be a finite non-negative integer",
			);
		}
		maxDepth = raw.maxDepth;
	}

	const approvedExtensions: Record<string, string> = {};
	if (raw.approvedExtensions !== undefined) {
		if (!isPlainObject(raw.approvedExtensions)) {
			throw new SubagentConfigError(
				"approvedExtensions must be an object of name -> ref",
			);
		}
		for (const [name, ref] of Object.entries(raw.approvedExtensions)) {
			if (!name.trim())
				throw new SubagentConfigError(
					"approvedExtensions keys must be non-empty",
				);
			if (typeof ref !== "string" || !ref.trim()) {
				throw new SubagentConfigError(
					`approvedExtensions["${name}"] must be a non-empty string`,
				);
			}
			approvedExtensions[name] = ref.trim();
		}
	}

	const excludedExtensions: string[] = [];
	if (raw.excludedExtensions !== undefined) {
		if (!Array.isArray(raw.excludedExtensions)) {
			throw new SubagentConfigError(
				"excludedExtensions must be an array of names",
			);
		}
		for (const entry of raw.excludedExtensions) {
			if (typeof entry !== "string" || !entry.trim()) {
				throw new SubagentConfigError(
					"excludedExtensions entries must be non-empty strings",
				);
			}
			excludedExtensions.push(entry.trim());
		}
	}

	return { maxDepth, approvedExtensions, excludedExtensions };
}

/** Read and validate `<agentDir>/pi-subagents.json`. Missing file uses defaults. */
export function loadOperatorConfig(agentDir: string): OperatorConfig {
	const path = join(agentDir, CONFIG_FILE_NAME);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return defaultOperatorConfig();
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new SubagentConfigError(
			`invalid JSON in ${path}: ${(error as Error).message}`,
		);
	}
	return parseOperatorConfig(raw);
}
