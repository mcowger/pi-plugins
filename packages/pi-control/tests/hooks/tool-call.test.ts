import { describe, expect, it, beforeAll, beforeEach, mock } from "bun:test"; // mock kept for ctx stubs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { initBashParser } from "../../src/utils/bash-ast.js";
import {
	handleToolCall,
	pendingNudges,
	sessionAllows,
	sessionAllowKey,
	denyTracker,
	nudgeTrackers,
	nudgeKey,
} from "../../src/hooks/tool-call.js";
import type {
	ControlsConfig,
	ControlsResolvedConfig,
} from "../../src/config.js";
import type {
	BashToolCallEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

beforeAll(async () => {
	await initBashParser((msg) => console.warn(msg));
});

// Minimal ExtensionContext stub.
let tmpHome: string | null = null;
let afterHome: string | undefined;

function setupTmpHome(): string {
	if (tmpHome) {
		throw new Error("tmp home already set; call cleanupTmpHome() first");
	}
	tmpHome = mkdtempSync(join(tmpdir(), "pi-controls-trust-"));
	afterHome = process.env.HOME;
	process.env.HOME = tmpHome;
	process.env.PI_CODING_AGENT_DIR = join(tmpHome, "agent");
	return tmpHome;
}

function cleanupTmpHome(): void {
	tmpHome = null;
	if (afterHome === undefined) delete process.env.HOME;
	else process.env.HOME = afterHome;
	delete process.env.PI_CODING_AGENT_DIR;
	afterHome = undefined;
}

function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		ui: {
			notify: mock(() => {}),
			confirm: mock(async () => true),
			select: mock(async () => "Allow"),
			setStatus: mock(() => {}),
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	} as any;
}

function bashEvent(command: string, id = "test-id"): BashToolCallEvent {
	return makeBash(command, id);
}

function makeBash(command: string, id = "test-id"): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: id,
		toolName: "bash",
		input: { command },
	};
}

function toolEvent(
	toolName: string,
	id = "test-id",
	extraInput: Record<string, unknown> = {},
): any {
	return {
		type: "tool_call",
		toolCallId: id,
		toolName,
		input: { ...extraInput },
	};
}

// Config where:
//   /tmp  → open  (allow everything)
//   everything else → locked (deny everything)
const config: ControlsResolvedConfig = {
	policies: {
		open: { defaultAction: "allow", rules: [] },
		locked: { defaultAction: "deny", rules: [] },
	},
	locations: {
		"/tmp": "open",
	},
	defaultPolicy: "locked",
	cycleKey: "ctrl+shift+m",
	agentTimeout: null,
	nudgeTimeout: null,
	pathProtection: null,
};

describe("tool-call handler — path arg location resolution", () => {
	// Bug regression: before the fix, `ls -la ~` used CWD for location resolution.
	// If CWD was under an allowed location, commands targeting restricted paths
	// were incorrectly allowed.
	it("denies ls -la ~ when home dir is not in any location (falls to locked defaultPolicy)", async () => {
		// CWD is /tmp (open), but ~ is the home dir which matches no location → locked.
		const result = await handleToolCall(
			bashEvent("ls -la ~"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("allows ls /tmp/foo when /tmp is open, even from a locked CWD", async () => {
		// CWD is /home/user (no location → locked), but the path arg is under /tmp (open).
		const result = await handleToolCall(
			bashEvent("ls /tmp/foo"),
			makeCtx("/home/user"),
			config,
		);
		expect(result).toBeUndefined();
	});

	it("denies when one path arg is locked even if another is open", async () => {
		// cp from /tmp (open) to ~ (locked) — most restrictive wins.
		const result = await handleToolCall(
			bashEvent("cp /tmp/foo ~"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("uses CWD when command has no path args or redirects", async () => {
		// No path args — CWD /tmp is open.
		const result = await handleToolCall(
			bashEvent("git status"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toBeUndefined();
	});

	it("uses CWD when command has no path args or redirects and CWD is locked", async () => {
		// No path args — CWD /home/user has no location → locked.
		const result = await handleToolCall(
			bashEvent("git status"),
			makeCtx("/home/user"),
			config,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});
});

describe("tool-call handler — interpreter source analysis", () => {
	it("denies a Python heredoc write to a locked literal path", async () => {
		const result = await handleToolCall(
			bashEvent(
				"python3 - <<'PY'\nfrom pathlib import Path\nPath('/home/user/out.txt').write_text('x')\nPY",
			),
			makeCtx("/tmp"),
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("/home/user/out.txt");
	});

	it("denies a Node inline write to a locked literal path", async () => {
		const result = await handleToolCall(
			bashEvent(
				`node -e 'require("fs").writeFileSync("/home/user/out.txt", "x")'`,
			),
			makeCtx("/tmp"),
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("/home/user/out.txt");
	});

	it("denies a Path.open write to a locked literal path", async () => {
		const result = await handleToolCall(
			bashEvent(
				`python3 -c 'from pathlib import Path; Path("/home/user/out.txt").open("w")'`,
			),
			makeCtx("/tmp"),
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("/home/user/out.txt");
	});

	it("asks for a conflicting interpreter invocation even with benign extracted source", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent("python3 ./unknown.py <<'PY'\nprint(1)\nPY"),
			ctx,
			config,
		);
		expect(result).toBeUndefined(); // test UI chooses Allow
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
		const title = (ctx.ui.select as ReturnType<typeof mock>).mock.calls[0]?.[0];
		expect(title).toContain("[pi-controls] Allow bash?\n\nCommand:\n");
		expect(title).toContain(
			"Reason for confirmation:\nStatic analysis could not prove the interpreter source safe:\n• python3 script files are not yet analyzed",
		);
		expect(title).toContain("Policy-evaluated target:\n• /tmp/unknown.py");
		expect(title).not.toContain("blocked path");
	});

	it("short-circuits the unknown-action fallback when every matched policy allow rule already trusts unanalyzed source", async () => {
		const config: ControlsResolvedConfig = {
			policies: {
				project: {
					defaultAction: "allow",
					rules: [
						{
							action: "allow",
							tool: "bash",
							pattern: "bun run*",
							allowUnanalyzed: true,
						},
					],
				},
			},
			locations: { $cwd: "project" },
			approvalRules: [],
			defaultPolicy: null,
			cycleKey: "ctrl+shift+m",
			agentTimeout: null,
			nudgeTimeout: null,
			pathProtection: null,
			interpreterAnalysis: {
				enabled: true,
				unknownAction: "ask",
				maxSourceBytes: 256 * 1024,
				maxDepth: 4,
				maxNodes: 10_000,
			},
		};
		const ctx = makeCtx("/tmp");
		const event = makeBash(
			"bun -e 'const sys = require(\"os\").platform();' ./src/index.ts",
		);
		const result = await handleToolCall(event, ctx, config);
		expect(result).toBeUndefined();
		expect(pendingNudges.size).toBe(0);
	});

	it("offers a Trust this pattern choice for interpreter fallback prompts", async () => {
		const tmpDir = setupTmpHome();
		try {
			await mkdir(join(tmpDir, ".pi/extensions"), { recursive: true });
			const config: ControlsResolvedConfig = {
				policies: {
					project: { defaultAction: "allow", rules: [] },
				},
				locations: { $cwd: "project" },
				approvalRules: [],
				defaultPolicy: null,
				cycleKey: "ctrl+shift+m",
				agentTimeout: null,
				nudgeTimeout: null,
				pathProtection: null,
				interpreterAnalysis: {
					enabled: true,
					unknownAction: "ask",
					maxSourceBytes: 256 * 1024,
					maxDepth: 4,
					maxNodes: 10_000,
				},
			};
			const ctx = makeCtx(tmpDir);
			const event = makeBash("python3 - <<'PY'\nimport custom_module\nPY");
			ctx.ui.select = (async (title: string, options: string[]) => {
				expect(title).toContain("Reason for confirmation");
				expect(options).toContain("Trust this pattern");
				expect(options).toContain("Allow for Project");
				return "Trust this pattern";
			}) as unknown as typeof ctx.ui.select;
			await handleToolCall(event, ctx, config);
			const projectConfigPath = join(
				tmpDir,
				"agent/extensions/pi-controls.jsonc",
			);
			const saved = JSON.parse(
				await readFile(projectConfigPath, "utf-8"),
			) as ControlsConfig;
			const rule = saved.approvalRules?.find(
				(entry) =>
					entry.tool === "bash" &&
					entry.action === "allow" &&
					entry.allowUnanalyzed === true,
			);
			expect(rule?.policy).toBe("project");
			expect(rule?.pattern).toBe("python3 *");
		} finally {
			cleanupTmpHome();
			delete process.env.PI_CODING_AGENT_DIR;
		}
	});

	it("allows an explicitly trusted unanalyzed Bun package script", async () => {
		const trustedConfig: ControlsResolvedConfig = {
			...config,
			policies: {
				...config.policies,
				open: {
					defaultAction: "allow",
					rules: [
						{
							action: "allow",
							tool: "bash",
							pattern: "bun run*",
							allowUnanalyzed: true,
						},
					],
				},
			},
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent("bun run build"),
			ctx,
			trustedConfig,
		);
		expect(result).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("still asks for a direct Bun script file without the explicit trust rule", async () => {
		const trustedConfig: ControlsResolvedConfig = {
			...config,
			policies: {
				...config.policies,
				open: {
					defaultAction: "allow",
					rules: [
						{
							action: "allow",
							tool: "bash",
							pattern: "bun run*",
							allowUnanalyzed: true,
						},
					],
				},
			},
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent("bun ./script.ts"),
			ctx,
			trustedConfig,
		);
		expect(result).toBeUndefined(); // test UI chooses Allow
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("denies a Bun TypeScript write to a locked literal path", async () => {
		const result = await handleToolCall(
			bashEvent(
				`bun -e 'const p: string = "/home/user/out.txt"; Bun.write(p, "x")'`,
			),
			makeCtx("/tmp"),
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("/home/user/out.txt");
	});

	it("asks when an interpreter write target is dynamic", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent(`python3 -c 'open(get_path(), "w")'`),
			ctx,
			config,
		);
		expect(result).toBeUndefined(); // test UI chooses Allow
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
		expect(
			(ctx.ui.select as ReturnType<typeof mock>).mock.calls[0]?.[0],
		).toContain("dynamic path");
	});

	it("fails closed when an interpreter ask is dismissed", async () => {
		const ctx = makeCtx("/tmp");
		ctx.ui.select = mock(async () => undefined) as any;
		const result = await handleToolCall(
			bashEvent(`node -e 'require("fs").writeFileSync(getPath(), "x")'`),
			ctx,
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Blocked by user");
	});

	it("silently allows source proven read-only under an open policy", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent(`python3 -c 'print(1)'`),
			ctx,
			config,
		);
		expect(result).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("recursively analyzes env and shell wrappers", async () => {
		const result = await handleToolCall(
			bashEvent(
				`env MODE=test bash -c "node -e 'require(\\"fs\\").writeFileSync(\\"/home/user/out.txt\\", \\"x\\")'"`,
			),
			makeCtx("/tmp"),
			config,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("/home/user/out.txt");
	});

	it("applies path protection to paths found in embedded source", async () => {
		const protectedConfig: ControlsResolvedConfig = {
			...config,
			pathProtection: { "*.env": "deny" },
		};
		const result = await handleToolCall(
			bashEvent(
				`node -e 'require("fs").writeFileSync("/tmp/secret.env", "x")'`,
			),
			makeCtx("/tmp"),
			protectedConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('protected pattern "*.env"');
	});

	it("inform mode reports uncertainty without prompting or blocking", async () => {
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent(`python3 -c 'open(get_path(), "w")'`),
			ctx,
			config,
			"inform",
		);
		expect(result).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
		expect(
			(ctx.ui.notify as ReturnType<typeof mock>).mock.calls[0]?.[0],
		).toContain("would-ask");
	});

	it("can disable interpreter analysis explicitly", async () => {
		const disabledConfig: ControlsResolvedConfig = {
			...config,
			interpreterAnalysis: null,
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent(`python3 -c 'open(get_path(), "w")'`),
			ctx,
			disabledConfig,
		);
		expect(result).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("can hard-deny unresolved source by configuration", async () => {
		const denyUnknownConfig: ControlsResolvedConfig = {
			...config,
			interpreterAnalysis: {
				enabled: true,
				unknownAction: "deny",
				maxSourceBytes: 262144,
				maxDepth: 4,
				maxNodes: 10000,
			},
		};
		const result = await handleToolCall(
			bashEvent(`python3 -c 'open(get_path(), "w")'`),
			makeCtx("/tmp"),
			denyUnknownConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Access denied");
		expect(result?.reason).toContain("could not prove the source safe");
	});
});

describe("nudge action", () => {
	const nudgeConfig: ControlsResolvedConfig = {
		policies: {
			nudged: {
				defaultAction: "allow",
				rules: [
					{
						action: "nudge",
						tool: "read",
						message: "use pluck_read instead",
					},
				],
			},
		},
		locations: { "/tmp": "nudged" },
		defaultPolicy: null,
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
	};

	it("allows the tool call (returns undefined) when action is nudge", async () => {
		const event = toolEvent("read", "nudge-call-1", {
			file_path: "/tmp/foo.ts",
		});
		const result = await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(result).toBeUndefined();
	});

	it("registers a pending nudge keyed by toolCallId", async () => {
		pendingNudges.clear();
		const event = toolEvent("read", "nudge-call-2", {
			file_path: "/tmp/bar.ts",
		});
		await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(pendingNudges.get("nudge-call-2")).toBe("use pluck_read instead");
	});

	it("does not register a pending nudge for allowed (non-nudge) tools", async () => {
		pendingNudges.clear();
		const event = toolEvent("grep", "nudge-call-3");
		await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(pendingNudges.has("nudge-call-3")).toBe(false);
	});
});

describe("agentTimeout escalation (deny → ask)", () => {
	// All calls land on /home/user which has no location → defaultPolicy=locked (deny all).
	const timeoutConfig: ControlsResolvedConfig = {
		policies: {
			locked: { defaultAction: "deny", rules: [] },
		},
		locations: {},
		defaultPolicy: "locked",
		cycleKey: "ctrl+shift+m",
		agentTimeout: { maxDenies: 3, windowSeconds: 60 },
		nudgeTimeout: null,
		pathProtection: null,
	};

	// Config without agentTimeout — baseline to confirm deny stays deny.
	const noTimeoutConfig: ControlsResolvedConfig = {
		...timeoutConfig,
		agentTimeout: null,
	};

	beforeEach(() => {
		denyTracker.reset();
	});

	it("denies without escalation when below the threshold", async () => {
		// First 2 denies — below maxDenies=3, no escalation.
		const r1 = await handleToolCall(
			bashEvent("rm -rf /"),
			makeCtx("/home/user"),
			timeoutConfig,
		);
		expect(r1).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});

		const r2 = await handleToolCall(
			bashEvent("rm -rf /"),
			makeCtx("/home/user"),
			timeoutConfig,
		);
		expect(r2).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("escalates to ask on the Nth denied call that meets the threshold", async () => {
		// Trigger threshold: record 3 denies — 3rd call should escalate.
		const ctx = makeCtx("/home/user");
		await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);

		// The select stub returns "Allow", so result is undefined (not blocked).
		const r3 = await handleToolCall(bashEvent("rm -rf /"), ctx, timeoutConfig);
		// ctx.ui.select was called (escalation happened); since mock returns "Allow", not blocked.
		expect(r3).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("does not escalate when agentTimeout is null", async () => {
		// Even with 5 denies, no escalation without config.
		const ctx = makeCtx("/home/user");
		for (let i = 0; i < 5; i++) {
			const r = await handleToolCall(
				bashEvent("rm -rf /"),
				ctx,
				noTimeoutConfig,
			);
			expect(r).toEqual({
				block: true,
				reason: expect.stringContaining("Access denied"),
			});
		}
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("escalates for non-bash tools too", async () => {
		// write tool calls on /home/user → locked → deny → escalate on 3rd.
		const ctx = makeCtx("/home/user");
		await handleToolCall(
			toolEvent("write", "w1", { file_path: "/home/user/x" }),
			ctx,
			timeoutConfig,
		);
		await handleToolCall(
			toolEvent("write", "w2", { file_path: "/home/user/x" }),
			ctx,
			timeoutConfig,
		);

		const r3 = await handleToolCall(
			toolEvent("write", "w3", { file_path: "/home/user/x" }),
			ctx,
			timeoutConfig,
		);
		expect(r3).toBeUndefined(); // select returned "Allow" → not blocked
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("continues escalating after the threshold is met until the window expires", async () => {
		const ctx = makeCtx("/home/user");
		// Reach the threshold.
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig); // 3rd → ask

		// 4th denied call should still escalate (tracker still above threshold).
		const r4 = await handleToolCall(bashEvent("rm /"), ctx, timeoutConfig);
		expect(r4).toBeUndefined(); // select returned "Allow"
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			2,
		);
	});
});

describe("nudgeTimeout escalation (nudge → deny)", () => {
	const nudgeMsg = "use pluck_read instead";

	const nudgeTimeoutConfig: ControlsResolvedConfig = {
		policies: {
			nudged: {
				defaultAction: "allow",
				rules: [
					{
						action: "nudge",
						tool: "read",
						message: nudgeMsg,
					},
				],
			},
		},
		locations: { "/tmp": "nudged" },
		defaultPolicy: null,
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: { maxNudges: 3, windowSeconds: 60 },
		pathProtection: null,
	};

	const noNudgeTimeoutConfig: ControlsResolvedConfig = {
		...nudgeTimeoutConfig,
		nudgeTimeout: null,
		pathProtection: null,
	};

	beforeEach(() => {
		pendingNudges.clear();
		nudgeTrackers.clear();
	});

	it("allows (nudges) below the threshold", async () => {
		const ctx = makeCtx("/tmp");
		for (let i = 0; i < 2; i++) {
			const r = await handleToolCall(
				toolEvent("read", `id-${i}`, { path: "/tmp/foo.ts" }),
				ctx,
				nudgeTimeoutConfig,
			);
			expect(r).toBeUndefined(); // still nudging — not blocked
		}
	});

	it("escalates to deny on the Nth nudge that meets the threshold", async () => {
		const ctx = makeCtx("/tmp");
		// First two: normal nudges.
		await handleToolCall(
			toolEvent("read", "nt-1", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		await handleToolCall(
			toolEvent("read", "nt-2", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);

		// Third nudge hits maxNudges=3 → deny.
		const r3 = await handleToolCall(
			toolEvent("read", "nt-3", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		expect(r3).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("deny reason mentions the ignored nudge message", async () => {
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			toolEvent("read", "nm-1", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		await handleToolCall(
			toolEvent("read", "nm-2", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		const r3 = await handleToolCall(
			toolEvent("read", "nm-3", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		expect(r3?.reason).toContain(nudgeMsg);
		expect(r3?.reason).toContain("You MUST switch approach now");
	});

	it("resets the counter after escalation, allowing nudges again", async () => {
		const ctx = makeCtx("/tmp");
		// Trigger escalation (3 nudges).
		await handleToolCall(
			toolEvent("read", "rs-1", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		await handleToolCall(
			toolEvent("read", "rs-2", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		await handleToolCall(
			toolEvent("read", "rs-3", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		); // deny + reset

		// After reset the 4th call should nudge again (not deny).
		const r4 = await handleToolCall(
			toolEvent("read", "rs-4", { path: "/tmp/foo.ts" }),
			ctx,
			nudgeTimeoutConfig,
		);
		expect(r4).toBeUndefined();
		expect(pendingNudges.get("rs-4")).toBe(nudgeMsg);
	});

	it("does not escalate when nudgeTimeout is null", async () => {
		const ctx = makeCtx("/tmp");
		for (let i = 0; i < 5; i++) {
			const r = await handleToolCall(
				toolEvent("read", `nn-${i}`, { path: "/tmp/foo.ts" }),
				ctx,
				noNudgeTimeoutConfig,
			);
			expect(r).toBeUndefined(); // always nudge, never deny
		}
	});

	it("tracks separate counters per rule (tool key)", async () => {
		// Build a config with two nudge rules: read and grep.
		const twoRuleConfig: ControlsResolvedConfig = {
			policies: {
				nudged: {
					defaultAction: "allow",
					rules: [
						{ action: "nudge", tool: "read", message: "use pluck_read" },
						{ action: "nudge", tool: "grep", message: "use pluck_grep" },
					],
				},
			},
			locations: { "/tmp": "nudged" },
			defaultPolicy: null,
			cycleKey: "ctrl+shift+m",
			agentTimeout: null,
			nudgeTimeout: { maxNudges: 2, windowSeconds: 60 },
			pathProtection: null,
		};

		const ctx = makeCtx("/tmp");
		// Trigger 2 read nudges — hits threshold for "read".
		await handleToolCall(
			toolEvent("read", "tr-1", { path: "/tmp/a" }),
			ctx,
			twoRuleConfig,
		);
		const r2 = await handleToolCall(
			toolEvent("read", "tr-2", { path: "/tmp/a" }),
			ctx,
			twoRuleConfig,
		);
		expect(r2).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});

		// grep counter is independent — first grep should still nudge.
		const grepR = await handleToolCall(
			toolEvent("grep", "tr-g1"),
			ctx,
			twoRuleConfig,
		);
		expect(grepR).toBeUndefined();
	});

	it("escalates bash nudge rules by pattern key", async () => {
		const bashNudgeConfig: ControlsResolvedConfig = {
			policies: {
				cwd: {
					defaultAction: "allow",
					rules: [
						{
							action: "nudge",
							tool: "bash",
							pattern: "cat *",
							message: "use pluck_read over cat",
						},
					],
				},
			},
			locations: { "/tmp": "cwd" },
			defaultPolicy: null,
			cycleKey: "ctrl+shift+m",
			agentTimeout: null,
			nudgeTimeout: { maxNudges: 2, windowSeconds: 60 },
			pathProtection: null,
		};

		const ctx = makeCtx("/tmp");
		await handleToolCall(bashEvent("cat /tmp/foo"), ctx, bashNudgeConfig);
		const r2 = await handleToolCall(
			bashEvent("cat /tmp/bar"),
			ctx,
			bashNudgeConfig,
		);
		expect(r2).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
		expect(r2?.reason).toContain("use pluck_read over cat");
	});
});

describe("sessionAllowKey", () => {
	it("builds key for non-bash tool with paths", () => {
		expect(sessionAllowKey("write", null, ["/home/user/x"])).toBe(
			"write:/home/user/x",
		);
	});

	it("joins multiple paths sorted", () => {
		expect(sessionAllowKey("read", null, ["/b", "/a"])).toBe("read:/a|/b");
	});

	it("uses __cwd__ when no paths", () => {
		expect(sessionAllowKey("grep", null, [])).toBe("grep:__cwd__");
	});

	it("builds key for bash with pattern (arity-based, matchedPattern ignored)", () => {
		expect(sessionAllowKey("bash", "rm -rf /tmp/x", ["/tmp"], "rm *")).toBe(
			"bash:rm *:/tmp",
		);
	});

	it("builds key for bash using arity suggestion", () => {
		expect(sessionAllowKey("bash", "git status", ["/home/user/project"])).toBe(
			"bash:git status*:/home/user/project",
		);
	});

	it("sorts paths in bash key", () => {
		expect(sessionAllowKey("bash", "cp a b", ["/dst", "/src"])).toBe(
			"bash:cp a *:/dst|/src",
		);
	});
});

describe("session allows", () => {
	const askConfig: ControlsResolvedConfig = {
		policies: {
			confirm: {
				defaultAction: "allow",
				rules: [{ action: "ask", tool: "write" }],
			},
		},
		locations: { "/tmp": "confirm" },
		defaultPolicy: null,
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		cycleKey: "ctrl+shift+m",
	};

	beforeEach(() => {
		sessionAllows.clear();
	});

	it("select offers session, project, and global allow choices", async () => {
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			toolEvent("write", "sel-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		const selectMock = ctx.ui.select as ReturnType<typeof mock>;
		expect(selectMock.mock.calls.length).toBe(1);
		const args = selectMock.mock.calls[0];
		expect(args[1]).toEqual([
			"Allow",
			"Allow for session",
			"Allow for Project",
			"Allow Globally",
			"Deny",
		]);
	});

	it("offers persistent approvals for a multi-policy bash call", async () => {
		const multiPolicyConfig: ControlsResolvedConfig = {
			...askConfig,
			policies: {
				open: { defaultAction: "ask", rules: [] },
				other: { defaultAction: "ask", rules: [] },
			},
			locations: { "/tmp": "open", "/home/user": "other" },
			defaultPolicy: null,
		};
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			bashEvent("cp /tmp/source /home/user/destination", "multi-policy"),
			ctx,
			multiPolicyConfig,
		);
		expect(
			(ctx.ui.select as ReturnType<typeof mock>).mock.calls[0]?.[1],
		).toEqual([
			"Allow",
			"Allow for session",
			"Allow for Project",
			"Allow Globally",
			"Deny",
		]);
	});

	it("honors a persisted approval before ordinary policy rules", async () => {
		const approvalConfig: ControlsResolvedConfig = {
			...askConfig,
			approvalRules: [{ action: "allow", tool: "write" }],
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			toolEvent("write", "persisted", { file_path: "/tmp/foo.ts" }),
			ctx,
			approvalConfig,
		);
		expect(result).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("does not apply a persisted approval to a different policy", async () => {
		const approvalConfig: ControlsResolvedConfig = {
			...askConfig,
			approvalRules: [
				{ action: "allow", tool: "write", policy: "other-policy" },
			],
		};
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			toolEvent("write", "different-policy", { file_path: "/tmp/foo.ts" }),
			ctx,
			approvalConfig,
		);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("allows the call when user picks Allow", async () => {
		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce("Allow");
		const result = await handleToolCall(
			toolEvent("write", "allow-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result).toBeUndefined();
		expect(sessionAllows.size).toBe(0); // not persisted for session
	});

	it("blocks the call when user picks Deny", async () => {
		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce("Deny");
		const result = await handleToolCall(
			toolEvent("write", "deny-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Blocked by user"),
		});
	});

	it("blocks the call when select returns undefined (dismissed)", async () => {
		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
		const result = await handleToolCall(
			toolEvent("write", "dismiss-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Blocked by user"),
		});
	});

	it("adds key and allows when user picks Allow for session", async () => {
		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce(
			"Allow for session",
		);
		const result = await handleToolCall(
			toolEvent("write", "sess-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result).toBeUndefined();
		expect(sessionAllows.has("write:/tmp/foo.ts")).toBe(true);
	});

	it("skips select on subsequent matching calls (auto-allows)", async () => {
		// First call — user picks "Allow for session"
		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce(
			"Allow for session",
		);
		await handleToolCall(
			toolEvent("write", "auto-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);

		// Second call to the same tool+path — should auto-allow without prompting.
		const result2 = await handleToolCall(
			toolEvent("write", "auto-2", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result2).toBeUndefined();
		// select was called only once (for the first call).
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("does not auto-allow different paths", async () => {
		const ctx = makeCtx("/tmp");
		// Allow for session on /tmp/foo.ts
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce(
			"Allow for session",
		);
		await handleToolCall(
			toolEvent("write", "diff-1", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);

		// Different path still asks.
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce("Deny");
		const result = await handleToolCall(
			toolEvent("write", "diff-2", { file_path: "/tmp/bar.ts" }),
			ctx,
			askConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Blocked by user"),
		});
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			2,
		);
	});

	it("auto-allows bash with pattern after Allow for session", async () => {
		const bashAskConfig: ControlsResolvedConfig = {
			policies: {
				confirm: {
					defaultAction: "allow",
					rules: [{ action: "ask", tool: "bash", pattern: "rm *" }],
				},
			},
			locations: { "/tmp": "confirm" },
			defaultPolicy: null,
			agentTimeout: null,
			nudgeTimeout: null,
			pathProtection: null,
			cycleKey: "ctrl+shift+m",
		};

		const ctx = makeCtx("/tmp");
		(ctx.ui.select as ReturnType<typeof mock>).mockResolvedValueOnce(
			"Allow for session",
		);
		await handleToolCall(bashEvent("rm /tmp/foo"), ctx, bashAskConfig);

		// Same pattern + same path → auto-allowed.
		const r2 = await handleToolCall(
			bashEvent("rm /tmp/foo"),
			ctx,
			bashAskConfig,
		);
		expect(r2).toBeUndefined();
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});
});
