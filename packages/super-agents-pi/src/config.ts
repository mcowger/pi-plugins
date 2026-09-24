import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_KEY } from "./constants.ts";
import type { SuperAgentsConfig } from "./types.ts";

export const DEFAULT_CONFIG: SuperAgentsConfig = {
	maxConcurrent: 8,
	maxTasksPerCall: 8,
	graceTurns: 3,
	maxResultBytes: 65536,
	maxEventBytes: 65536,
	events: { enabled: true },
	overflowDir: undefined,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function cloneConfig(config: SuperAgentsConfig): SuperAgentsConfig {
	return { ...config, events: { ...config.events } };
}

function applyPartial(config: SuperAgentsConfig, partial: unknown, warnings: string[]): SuperAgentsConfig {
	if (!isPlainObject(partial)) return config;
	const next = cloneConfig(config);

	for (const [key, value] of Object.entries(partial)) {
		switch (key) {
			case "maxConcurrent":
				if (isInteger(value, 1)) next.maxConcurrent = value;
				else warnings.push("super-agents-pi: invalid value for 'maxConcurrent': expected an integer >= 1");
				break;
			case "maxTasksPerCall":
				if (isInteger(value, 1)) next.maxTasksPerCall = value;
				else warnings.push("super-agents-pi: invalid value for 'maxTasksPerCall': expected an integer >= 1");
				break;
			case "graceTurns":
				if (isInteger(value, 0)) next.graceTurns = value;
				else warnings.push("super-agents-pi: invalid value for 'graceTurns': expected an integer >= 0");
				break;
			case "maxResultBytes":
				if (isInteger(value, 1024)) next.maxResultBytes = value;
				else warnings.push("super-agents-pi: invalid value for 'maxResultBytes': expected an integer >= 1024");
				break;
			case "maxEventBytes":
				if (isInteger(value, 1024)) next.maxEventBytes = value;
				else warnings.push("super-agents-pi: invalid value for 'maxEventBytes': expected an integer >= 1024");
				break;
			case "events":
				if (!isPlainObject(value)) {
					warnings.push("super-agents-pi: invalid value for 'events': expected an object");
					break;
				}
				for (const [eventsKey, eventsValue] of Object.entries(value)) {
					if (eventsKey === "enabled") {
						if (typeof eventsValue === "boolean") next.events.enabled = eventsValue;
						else warnings.push("super-agents-pi: invalid value for 'events.enabled': expected a boolean");
					} else {
						warnings.push(`super-agents-pi: unknown config key 'events.${eventsKey}'`);
					}
				}
				break;
			case "overflowDir":
				if (typeof value === "string" && value.length > 0) next.overflowDir = value;
				else warnings.push("super-agents-pi: invalid value for 'overflowDir': expected a non-empty string");
				break;
			default:
				warnings.push(`super-agents-pi: unknown config key '${key}'`);
		}
	}

	return next;
}

function mergeConfigWithWarnings(...partials: Array<unknown>): { config: SuperAgentsConfig; warnings: string[] } {
	const warnings: string[] = [];
	let config = cloneConfig(DEFAULT_CONFIG);
	for (const partial of partials) {
		config = applyPartial(config, partial, warnings);
	}
	return { config, warnings };
}

export function mergeConfig(...partials: Array<unknown>): SuperAgentsConfig {
	return mergeConfigWithWarnings(...partials).config;
}

function readSuperAgentsSettings(path: string, warnings: string[]): unknown {
	if (!existsSync(path)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`super-agents-pi: could not parse ${path}: ${message}`);
		return undefined;
	}

	if (!isPlainObject(parsed)) return undefined;
	const superAgents = parsed[SETTINGS_KEY];
	return isPlainObject(superAgents) ? superAgents : undefined;
}

export function loadConfig(cwd: string, agentDir: string): { config: SuperAgentsConfig; warnings: string[] } {
	const warnings: string[] = [];
	const globalPartial = readSuperAgentsSettings(join(agentDir, "settings.json"), warnings);
	const projectPartial = readSuperAgentsSettings(join(cwd, ".pi", "settings.json"), warnings);

	const merged = mergeConfigWithWarnings(globalPartial, projectPartial);
	warnings.push(...merged.warnings);

	return { config: merged.config, warnings };
}
