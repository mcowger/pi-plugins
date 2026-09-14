import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApprovalRule, findProjectConfigPath } from "../src/config.js";

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
			allowUnanalyzed: true,
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
			"pattern": "git push *",
			"allowUnanalyzed": true
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
