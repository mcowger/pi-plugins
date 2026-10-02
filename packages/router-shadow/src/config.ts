/**
 * Configuration (REQUIREMENTS R12).
 *
 * Read from the pi settings key `routerShadow`, with environment overrides.
 * Missing `apiBase`/`apiKey` disables the extension (single notify at the
 * call site). The API key is never logged.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RouterShadowConfig {
	enabled: boolean;
	candidates: string[];
	apiBase: string;
	apiKey: string;
	jevModel: string;
	k: number;
	bundlePath: string;
	modelsPath: string;
	logDir: string;
	sampleRate: number;
	routeSubagents: boolean;
	footer: boolean;
}

export const DEFAULT_CANDIDATES = ["jev-all", "jev-k24", "jev-zeroshot"];
export const DEFAULT_JEV_MODEL = "jev-1.13";
export const DEFAULT_K = 24;

export function defaultLogDir(): string {
	return join(homedir(), ".pi", "agent", "router-shadow");
}

/** Cached saved-config read (mirrors the plexus plugin's own caching). */
let cachedPlexusConfig: { mtimeMs: number; baseUrl: string } | null = null;

function readSavedPlexusBaseUrl(agentDir: string): string {
	if (!agentDir) return "";
	const path = join(agentDir, "extensions", "plexus", "config.json");
	try {
		const stat = statSync(path);
		if (cachedPlexusConfig && cachedPlexusConfig.mtimeMs === stat.mtimeMs) {
			return cachedPlexusConfig.baseUrl;
		}
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const baseUrl =
			raw !== null && typeof raw === "object"
				? (raw as Record<string, unknown>).baseUrl
				: null;
		const value = typeof baseUrl === "string" ? baseUrl.trim() : "";
		cachedPlexusConfig = { mtimeMs: stat.mtimeMs, baseUrl: value };
		return value;
	} catch {
		cachedPlexusConfig = null;
		return "";
	}
}

/** Test seam: drop the saved-config cache. */
export function clearPlexusBaseUrlCache(): void {
	cachedPlexusConfig = null;
}

/**
 * Resolve the Plexus base URL the way the plexus plugin does: explicit env
 * (`PLEXUS_API_URL`, then `PLEXUS_BASE_URL`), then its saved config file.
 * Any form (with or without `/v1`) works — `joinUrl` normalizes it.
 */
export function resolvePlexusBaseUrl(
	env: Record<string, string | undefined>,
	agentDir: string,
): string {
	const fromEnv =
		(typeof env.PLEXUS_API_URL === "string" && env.PLEXUS_API_URL.trim()) ||
		(typeof env.PLEXUS_BASE_URL === "string" && env.PLEXUS_BASE_URL.trim()) ||
		"";
	if (fromEnv) return fromEnv;
	return readSavedPlexusBaseUrl(agentDir);
}

function parseCandidates(value: unknown): string[] | null {
	if (Array.isArray(value)) {
		const ids = value.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
		return ids.length > 0 ? ids : null;
	}
	if (typeof value === "string" && value.trim()) {
		const ids = value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		return ids.length > 0 ? ids : null;
	}
	return null;
}

function parseBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(lowered)) return true;
		if (["0", "false", "no", "off"].includes(lowered)) return false;
	}
	return null;
}

function parseNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

export interface ConfigSources {
	settings?: unknown;
	env?: Record<string, string | undefined>;
	extensionDir?: string;
	/** Base URL inherited from the plexus plugin (see `resolvePlexusBaseUrl`). */
	plexusBaseUrl?: string;
}

/** Merge settings + env over the R12 defaults. Never throws. */
export function loadConfig(sources: ConfigSources = {}): RouterShadowConfig {
	const settings =
		sources.settings !== null &&
		typeof sources.settings === "object" &&
		!Array.isArray(sources.settings)
			? (sources.settings as Record<string, unknown>)
			: {};
	const env = sources.env ?? process.env;
	const extensionDir = sources.extensionDir ?? "";

	const envCandidates = parseCandidates(env.ROUTER_SHADOW_CANDIDATES);
	const settingsCandidates = parseCandidates(settings.candidates);

	const sampleRate =
		parseNumber(env.ROUTER_SHADOW_SAMPLE_RATE ?? settings.sampleRate) ?? 1.0;
	const k = Math.max(1, Math.floor(parseNumber(settings.k) ?? DEFAULT_K));

	const explicitBase =
		(typeof settings.apiBase === "string" && settings.apiBase) || "";
	const envBase =
		(typeof env.PLEXUS_API_BASE === "string" && env.PLEXUS_API_BASE) || "";
	const inheritedBase =
		(typeof sources.plexusBaseUrl === "string" && sources.plexusBaseUrl) || "";

	return {
		enabled:
			parseBoolean(env.ROUTER_SHADOW_ENABLED ?? settings.enabled) ?? true,
		candidates: envCandidates ?? settingsCandidates ?? [...DEFAULT_CANDIDATES],
		// Dedicated env var wins, then explicit settings, then whatever the
		// plexus plugin resolved (its env vars / saved config).
		apiBase: envBase || explicitBase || inheritedBase,
		apiKey:
			(typeof env.PLEXUS_API_KEY === "string" && env.PLEXUS_API_KEY) ||
			(typeof settings.apiKey === "string" ? settings.apiKey : "") ||
			"",
		jevModel:
			(typeof settings.jevModel === "string" && settings.jevModel) ||
			DEFAULT_JEV_MODEL,
		k,
		bundlePath:
			(typeof settings.bundlePath === "string" && settings.bundlePath) ||
			join(extensionDir, "exemplars.json"),
		modelsPath:
			(typeof settings.modelsPath === "string" && settings.modelsPath) ||
			join(extensionDir, "models.json"),
		logDir:
			(typeof settings.logDir === "string" && settings.logDir) ||
			defaultLogDir(),
		sampleRate: Math.min(1, Math.max(0, sampleRate)),
		routeSubagents: parseBoolean(settings.routeSubagents) ?? true,
		footer: parseBoolean(settings.footer) ?? false,
	};
}
