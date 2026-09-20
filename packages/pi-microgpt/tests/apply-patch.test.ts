import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveUnrestricted, rewritePatchPaths } from "../src/apply-patch.ts";
import piMicroGpt from "../src/index.ts";

function mockPi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	return {
		commands,
		handlers,
		tools,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerShortcut() {},
		getActiveTools: () => ["edit", "write"],
		setActiveTools() {},
		on(name: string, handler: any) { handlers.set(name, handler); },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
}

async function outsideDir() {
	const root = await mkdtemp(path.join(tmpdir(), "microgpt-patch-"));
	const session = path.join(root, "session");
	const outside = path.join(root, "outside");
	await mkdir(session, { recursive: true });
	await mkdir(outside, { recursive: true });
	return { root, session, outside };
}

test("rewritePatchPaths resolves relatives against the session cwd without confinement", async () => {
	const { root, session } = await outsideDir();
	try {
		const rewritten = await rewritePatchPaths(
			"*** Begin Patch\n*** Update File: ../outside/file.txt\n@@\n-a\n+b\n*** End Patch",
			session,
		);
		expect(rewritten).toContain(`*** Update File: ${path.join(root, "outside", "file.txt")}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rewritePatchPaths leaves absolute paths and patch content lines alone", async () => {
	const rewritten = await rewritePatchPaths(
		"*** Begin Patch\n*** Add File: /tmp/elsewhere/new.txt\n+*** Add File: /tmp/elsewhere/decoy.txt\n*** End Patch",
		"/tmp/session",
	);
	expect(rewritten).toContain("*** Add File: /tmp/elsewhere/new.txt");
	expect(rewritten).toContain("+*** Add File: /tmp/elsewhere/decoy.txt");
});

test("resolveUnrestricted follows symlinks to the real location", async () => {
	const { root, session, outside } = await outsideDir();
	try {
		await symlink(outside, path.join(session, "link"));
		expect(await resolveUnrestricted(session, "link/file.txt")).toBe(path.join(outside, "file.txt"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("apply_patch writes outside the session cwd via absolute and .. paths", async () => {
	const { root, session, outside } = await outsideDir();
	try {
		const pi = mockPi();
		piMicroGpt(pi as any);
		const tool = pi.tools.get("apply_patch");
		await writeFile(path.join(outside, "existing.txt"), "old\n");

		const result = await tool.execute(
			"call-1",
			{
				input: [
					"*** Begin Patch",
					`*** Add File: ${path.join(outside, "created.txt")}`,
					"+created",
					"*** Update File: ../outside/existing.txt",
					"@@",
					"-old",
					"+new",
					"*** End Patch",
				].join("\n"),
			},
			undefined,
			undefined,
			{ cwd: session } as any,
		);
		expect(result.details.result.failures).toEqual([]);
		expect(await readFile(path.join(outside, "created.txt"), "utf-8")).toBe("created\n");
		expect(await readFile(path.join(outside, "existing.txt"), "utf-8")).toBe("new\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("apply_patch follows a symlinked path to its target", async () => {
	const { root, session, outside } = await outsideDir();
	try {
		await symlink(outside, path.join(session, "link"));
		const pi = mockPi();
		piMicroGpt(pi as any);
		const tool = pi.tools.get("apply_patch");

		const result = await tool.execute(
			"call-1",
			{ input: "*** Begin Patch\n*** Add File: link/sym.txt\n+via symlink\n*** End Patch" },
			undefined,
			undefined,
			{ cwd: session } as any,
		);
		expect(result.details.result.failures).toEqual([]);
		expect(await readFile(path.join(outside, "sym.txt"), "utf-8")).toBe("via symlink\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
