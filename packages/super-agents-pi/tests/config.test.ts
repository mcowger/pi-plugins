import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../src/config.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDirs(): Promise<{ agentDir: string; cwd: string }> {
	const agentDir = await mkdtemp(join(tmpdir(), "super-agents-pi-agentdir-"));
	const cwd = await mkdtemp(join(tmpdir(), "super-agents-pi-cwd-"));
	createdDirs.push(agentDir, cwd);
	return { agentDir, cwd };
}

async function writeJson(dir: string, filename: string, content: unknown): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, filename), JSON.stringify(content), "utf-8");
}

describe("loadConfig", () => {
	it("returns defaults when no settings files exist", async () => {
		const { agentDir, cwd } = await tempDirs();
		const { config, warnings } = loadConfig(cwd, agentDir);
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});

	it("applies global over defaults, then project over global, per key, with events merged per key", async () => {
		const { agentDir, cwd } = await tempDirs();
		await writeJson(agentDir, "settings.json", {
			superAgents: { maxConcurrent: 2, graceTurns: 5, events: { enabled: false } },
		});
		await writeJson(join(cwd, ".pi"), "settings.json", {
			superAgents: { maxConcurrent: 4 },
		});

		const { config, warnings } = loadConfig(cwd, agentDir);

		expect(config.maxConcurrent).toBe(4); // project overrides global
		expect(config.graceTurns).toBe(5); // global value survives (untouched by project)
		expect(config.events.enabled).toBe(false); // events merged key-by-key from global
		expect(config.maxTasksPerCall).toBe(DEFAULT_CONFIG.maxTasksPerCall); // default survives
		expect(warnings).toEqual([]);
	});

	it("warns on invalid values and keeps the previous value", async () => {
		const { agentDir, cwd } = await tempDirs();
		await writeJson(agentDir, "settings.json", {
			superAgents: {
				maxConcurrent: -1,
				maxTasksPerCall: 1.5,
				graceTurns: -2,
				maxResultBytes: 10,
				maxEventBytes: "big",
				overflowDir: "",
				events: { enabled: "yes", bogusKey: 1 },
				unknownTopLevelKey: 1,
			},
		});

		const { config, warnings } = loadConfig(cwd, agentDir);

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings.some((w) => w.includes("maxConcurrent"))).toBe(true);
		expect(warnings.some((w) => w.includes("maxTasksPerCall"))).toBe(true);
		expect(warnings.some((w) => w.includes("graceTurns"))).toBe(true);
		expect(warnings.some((w) => w.includes("maxResultBytes"))).toBe(true);
		expect(warnings.some((w) => w.includes("maxEventBytes"))).toBe(true);
		expect(warnings.some((w) => w.includes("overflowDir"))).toBe(true);
		expect(warnings.some((w) => w.includes("events.enabled"))).toBe(true);
		expect(warnings.some((w) => w.includes("events.bogusKey"))).toBe(true);
		expect(warnings.some((w) => w.includes("unknownTopLevelKey"))).toBe(true);
	});

	it("warns and skips a file with invalid JSON, without throwing", async () => {
		const { agentDir, cwd } = await tempDirs();
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), "{ not valid json", "utf-8");

		const { config, warnings } = loadConfig(cwd, agentDir);

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not parse");
		expect(warnings[0]).toContain(join(agentDir, "settings.json"));
	});

	it("skips settings.json without a superAgents object", async () => {
		const { agentDir, cwd } = await tempDirs();
		await writeJson(agentDir, "settings.json", { superAgents: "nonsense", otherKey: true });

		const { config, warnings } = loadConfig(cwd, agentDir);

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});
});

describe("mergeConfig", () => {
	it("starts from DEFAULT_CONFIG and applies partials in order", () => {
		const config = mergeConfig({ maxConcurrent: 3 }, { maxConcurrent: 6, maxTasksPerCall: 5 });
		expect(config.maxConcurrent).toBe(6);
		expect(config.maxTasksPerCall).toBe(5);
		expect(config.graceTurns).toBe(DEFAULT_CONFIG.graceTurns);
	});

	it("ignores non-object partials", () => {
		expect(mergeConfig(null, undefined, 42, "nope")).toEqual(DEFAULT_CONFIG);
	});
});
