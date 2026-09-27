import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addApprovalRule,
	DEFAULT_DECISIONS,
	findProjectConfigPath,
	resolveDecisions,
} from "../src/config.js";

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("interactive approval config", () => {
	it("creates a project config with an allow rule when none exists", async () => {
		const project = await mkdtemp(join(tmpdir(), "pi-controls-config-"));
		createdDirectories.push(project);

		const result = await addApprovalRule("project", project, {
			action: "allow",
			tool: "bash",
			pattern: "git push *",
		});

		expect(result).toEqual({
			path: findProjectConfigPath(project),
			added: true,
		});
		expect(await readFile(result.path, "utf8")).toBe(`{
	"approvalRules": [
		{
			"action": "allow",
			"tool": "bash",
			"pattern": "git push *"
		}
	]
}
`);
	});

	it("preserves unrelated JSONC content and does not duplicate a saved rule", async () => {
		const project = await mkdtemp(join(tmpdir(), "pi-controls-config-"));
		createdDirectories.push(project);
		const path = findProjectConfigPath(project);
		await mkdir(join(project, ".pi/extensions"), { recursive: true });
		await writeFile(
			path,
			`{
	// Keep this comment.
	"defaultPolicy": "strict"
}
`,
		);

		const rule = { action: "allow" as const, tool: "write" };
		expect((await addApprovalRule("project", project, rule)).added).toBe(true);
		expect((await addApprovalRule("project", project, rule)).added).toBe(false);

		const raw = await readFile(path, "utf8");
		expect(raw).toContain("// Keep this comment.");
		expect(raw.match(/"tool": "write"/g)).toHaveLength(1);
	});
});

describe("resolveDecisions", () => {
	it("returns null when the block is absent or not an object", () => {
		expect(resolveDecisions(undefined)).toBeNull();
		expect(resolveDecisions(null)).toBeNull();
		expect(resolveDecisions("https://example.invalid")).toBeNull();
		expect(resolveDecisions(["decisions"])).toBeNull();
	});

	it("fills an empty block with code defaults", () => {
		expect(resolveDecisions({})).toEqual(DEFAULT_DECISIONS);
	});

	it("overrides individual fields including a single weight", () => {
		const resolved = resolveDecisions({
			model: "other/model",
			backstopThreshold: 10,
			weights: { network: 50 },
		});
		expect(resolved?.model).toBe("other/model");
		expect(resolved?.backstopThreshold).toBe(10);
		expect(resolved?.weights.network).toBe(50);
		expect(resolved?.weights.exec).toBe(DEFAULT_DECISIONS.weights.exec);
	});

	it("falls back to defaults for invalid values", () => {
		const resolved = resolveDecisions({
			url: "",
			timeoutMs: -5,
			maxSourceBytes: Number.NaN,
			unavailableAction: "nudge",
			errorAction: "sometimes",
			yesThreshold: 0.2,
			noThreshold: 0.8,
			choiceConfidence: 7,
			weights: { destructive: -1, network: "lots" },
		});
		expect(resolved?.url).toBe(DEFAULT_DECISIONS.url);
		expect(resolved?.timeoutMs).toBe(DEFAULT_DECISIONS.timeoutMs);
		expect(resolved?.maxSourceBytes).toBe(DEFAULT_DECISIONS.maxSourceBytes);
		expect(resolved?.unavailableAction).toBe("ask");
		expect(resolved?.errorAction).toBe("ask");
		expect(resolved?.yesThreshold).toBe(DEFAULT_DECISIONS.yesThreshold);
		expect(resolved?.noThreshold).toBe(DEFAULT_DECISIONS.noThreshold);
		expect(resolved?.choiceConfidence).toBe(DEFAULT_DECISIONS.choiceConfidence);
		expect(resolved?.weights.destructive).toBe(
			DEFAULT_DECISIONS.weights.destructive,
		);
		expect(resolved?.weights.network).toBe(DEFAULT_DECISIONS.weights.network);
	});

	it("accepts valid custom thresholds", () => {
		const resolved = resolveDecisions({
			yesThreshold: 0.8,
			noThreshold: 0.2,
			errorAction: "deny",
		});
		expect(resolved?.yesThreshold).toBe(0.8);
		expect(resolved?.noThreshold).toBe(0.2);
		expect(resolved?.errorAction).toBe("deny");
	});
});
