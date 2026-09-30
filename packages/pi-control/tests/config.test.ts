import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addApprovalRule,
	DEFAULT_AUTO,
	DEFAULT_DECISIONS,
	findProjectConfigPath,
	resolveAuto,
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

	it("resolves decisions.auto over the auto defaults", () => {
		expect(resolveDecisions({})?.auto).toEqual(DEFAULT_AUTO);
		const resolved = resolveDecisions({ auto: { deny: false } });
		expect(resolved?.auto.deny).toBe(false);
		expect(resolved?.auto.backstopThreshold).toBe(
			DEFAULT_AUTO.backstopThreshold,
		);
	});
});

describe("resolveAuto", () => {
	it("fills per-question thresholds from the globals", () => {
		const resolved = resolveAuto({ yesThreshold: 0.8, choiceConfidence: 0.7 });
		expect(resolved.thresholds.destructive).toEqual({ yes: 0.8, no: 0.3 });
		expect(resolved.thresholds.scope).toEqual({
			confidence: 0.7,
			riskyMass: DEFAULT_AUTO.riskyMassThreshold,
		});
	});

	it("applies valid per-question overrides and ignores invalid ones", () => {
		const resolved = resolveAuto({
			thresholds: {
				destructive: { yes: 0.5, no: 0.1 },
				network: { yes: 0.2, no: 0.4 },
				concealed: { yes: 2 },
				scope: { confidence: 0.9, riskyMass: 0 },
				bogus: { yes: 0.1 },
			},
		});
		expect(resolved.thresholds.destructive).toEqual({ yes: 0.5, no: 0.1 });
		expect(resolved.thresholds.network).toEqual(
			DEFAULT_AUTO.thresholds.network,
		);
		expect(resolved.thresholds.concealed).toEqual(
			DEFAULT_AUTO.thresholds.concealed,
		);
		expect(resolved.thresholds.scope).toEqual({
			confidence: 0.9,
			riskyMass: DEFAULT_AUTO.riskyMassThreshold,
		});
		expect(resolved.thresholds).not.toHaveProperty("bogus");
	});

	it("fills an absent or invalid block with code defaults", () => {
		expect(resolveAuto(undefined)).toEqual(DEFAULT_AUTO);
		expect(resolveAuto(null)).toEqual(DEFAULT_AUTO);
		expect(resolveAuto("nope")).toEqual(DEFAULT_AUTO);
		expect(resolveAuto([])).toEqual(DEFAULT_AUTO);
		expect(resolveAuto({})).toEqual(DEFAULT_AUTO);
	});

	it("overrides individual fields including a single weight", () => {
		const resolved = resolveAuto({
			backstopThreshold: 12,
			maxInputBytes: 1024,
			maxConversationTurns: 3,
			weights: { scopeRisky: 5 },
		});
		expect(resolved.backstopThreshold).toBe(12);
		expect(resolved.maxInputBytes).toBe(1024);
		expect(resolved.maxConversationTurns).toBe(3);
		expect(resolved.weights.scopeRisky).toBe(5);
		expect(resolved.weights.destructive).toBe(DEFAULT_AUTO.weights.destructive);
	});

	it("falls back to defaults for invalid values", () => {
		const resolved = resolveAuto({
			yesThreshold: 0.2,
			noThreshold: 0.8,
			choiceConfidence: 7,
			riskyMassThreshold: 0,
			backstopThreshold: -1,
			maxConversationBytes: Number.NaN,
			weights: { destructive: -1, network: "lots" },
		});
		expect(resolved.yesThreshold).toBe(DEFAULT_AUTO.yesThreshold);
		expect(resolved.noThreshold).toBe(DEFAULT_AUTO.noThreshold);
		expect(resolved.choiceConfidence).toBe(DEFAULT_AUTO.choiceConfidence);
		expect(resolved.riskyMassThreshold).toBe(DEFAULT_AUTO.riskyMassThreshold);
		expect(resolved.backstopThreshold).toBe(DEFAULT_AUTO.backstopThreshold);
		expect(resolved.maxConversationBytes).toBe(
			DEFAULT_AUTO.maxConversationBytes,
		);
		expect(resolved.weights.destructive).toBe(DEFAULT_AUTO.weights.destructive);
		expect(resolved.weights.network).toBe(DEFAULT_AUTO.weights.network);
	});

	it("treats only an explicit false as disabling deny", () => {
		expect(resolveAuto({ deny: false }).deny).toBe(false);
		expect(resolveAuto({ deny: true }).deny).toBe(true);
		expect(resolveAuto({ deny: "no" }).deny).toBe(true);
	});

	it("sanitizes per-question overrides", () => {
		const resolved = resolveAuto({
			questions: {
				action_class: {
					instructions: "custom",
					criteria: { local_write: "write", bad: 5 },
				},
				junk: 7,
			},
		});
		expect(resolved.questions.action_class).toEqual({
			instructions: "custom",
			criteria: { local_write: "write" },
		});
		expect(resolved.questions.junk).toBeUndefined();
	});
});
