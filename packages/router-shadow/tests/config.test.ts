import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearPlexusBaseUrlCache,
	loadConfig,
	resolvePlexusBaseUrl,
} from "../src/config.js";

test("resolvePlexusBaseUrl prefers PLEXUS_API_URL over PLEXUS_BASE_URL", () => {
	clearPlexusBaseUrlCache();
	expect(
		resolvePlexusBaseUrl(
			{
				PLEXUS_API_URL: "https://a.example",
				PLEXUS_BASE_URL: "https://b.example",
			},
			"/nonexistent",
		),
	).toBe("https://a.example");
	expect(
		resolvePlexusBaseUrl(
			{ PLEXUS_BASE_URL: "https://b.example" },
			"/nonexistent",
		),
	).toBe("https://b.example");
});

test("resolvePlexusBaseUrl falls back to the plexus plugin saved config", async () => {
	clearPlexusBaseUrlCache();
	const agentDir = await mkdtemp(join(tmpdir(), "agent-dir-"));
	await mkdir(join(agentDir, "extensions", "plexus"), { recursive: true });
	await writeFile(
		join(agentDir, "extensions", "plexus", "config.json"),
		JSON.stringify({ baseUrl: "https://plexus.example" }),
	);
	expect(resolvePlexusBaseUrl({}, agentDir)).toBe("https://plexus.example");
	expect(resolvePlexusBaseUrl({}, "/nonexistent")).toBe("");
	clearPlexusBaseUrlCache();
});

test("loadConfig inherits the plexus base URL when nothing explicit is set", () => {
	const inherited = loadConfig({
		env: {},
		plexusBaseUrl: "https://plexus.example",
	});
	expect(inherited.apiBase).toBe("https://plexus.example");

	const explicit = loadConfig({
		env: {},
		settings: { apiBase: "https://explicit.example" },
		plexusBaseUrl: "https://plexus.example",
	});
	expect(explicit.apiBase).toBe("https://explicit.example");

	const envWins = loadConfig({
		env: { PLEXUS_API_BASE: "https://env.example" },
		settings: { apiBase: "https://explicit.example" },
		plexusBaseUrl: "https://plexus.example",
	});
	expect(envWins.apiBase).toBe("https://env.example");
});
