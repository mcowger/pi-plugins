import {
	describe,
	expect,
	it,
	beforeAll,
	beforeEach,
	afterEach,
	afterAll,
	mock,
} from "bun:test"; // mock kept for ctx stubs
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { initBashParser } from "../../src/utils/bash-ast.js";
import { ForwardingManager } from "../../src/utils/forwarding.js";
import {
	defaultForwardingDir,
	forwardingLocation,
	listJsonFiles,
} from "../../src/utils/forwarding-io.js";
import {
	getServingSessionRegistry,
	getSubagentSessionRegistry,
} from "../../src/utils/subagent.js";
import {
	handleToolCall,
	formatNudgeMessage,
	pendingNudges,
	sessionAllows,
	sessionAllowKey,
	denyTracker,
	nudgeTrackers,
	nudgeKey,
	resetDecisionWarnings,
} from "../../src/hooks/tool-call.js";
import type {
	ControlsConfig,
	ControlsResolvedConfig,
} from "../../src/config.js";
import { resolveDecisions } from "../../src/config.js";
import { clearEvalCache } from "../../src/utils/decisions.js";
import { clearAutoCache } from "../../src/utils/auto-decisions.js";
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
		sessionManager: {
			getSessionId: () => "test-session",
			getBranch: () => [],
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
	decisions: null,
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
		decisions: null,
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
		const stored = pendingNudges.get("nudge-call-2") ?? "";
		expect(stored).toContain("use pluck_read instead");
		expect(stored).toContain("You called the `read` tool");
	});

	it("does not register a pending nudge for allowed (non-nudge) tools", async () => {
		pendingNudges.clear();
		const event = toolEvent("grep", "nudge-call-3");
		await handleToolCall(event, makeCtx("/tmp"), nudgeConfig);
		expect(pendingNudges.has("nudge-call-3")).toBe(false);
	});
});

describe("piped bash nudge suppression", () => {
	const grepNudgeConfig: ControlsResolvedConfig = {
		policies: {
			nudged: {
				defaultAction: "allow",
				rules: [
					{
						action: "nudge",
						tool: "bash",
						pattern: "grep *",
						message: "Prefer the grep tool over grep",
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
		decisions: null,
	};

	it("nudges when grep is called directly", async () => {
		pendingNudges.clear();
		await handleToolCall(
			bashEvent("grep foo", "pipe-nudge-1"),
			makeCtx("/tmp"),
			grepNudgeConfig,
		);
		const stored = pendingNudges.get("pipe-nudge-1") ?? "";
		expect(stored).toContain("Prefer the grep tool over grep");
		expect(stored).toContain("You ran bash `grep foo`");
		expect(stored).toContain("matched pattern `grep *`");
	});

	it("does not nudge when grep is a pipe target", async () => {
		pendingNudges.clear();
		await handleToolCall(
			bashEvent(
				'bun --cwd packages/pi-control test 2>&1 | grep -E "(fail)"',
				"pipe-nudge-2",
			),
			makeCtx("/tmp"),
			grepNudgeConfig,
		);
		expect(pendingNudges.has("pipe-nudge-2")).toBe(false);
	});

	it("still nudges first-stage grep whose output is piped elsewhere", async () => {
		pendingNudges.clear();
		await handleToolCall(
			bashEvent("grep foo file.txt | head", "pipe-nudge-3"),
			makeCtx("/tmp"),
			grepNudgeConfig,
		);
		const stored = pendingNudges.get("pipe-nudge-3") ?? "";
		expect(stored).toContain("Prefer the grep tool over grep");
		expect(stored).toContain("You ran bash");
		expect(stored).toContain("matched pattern `grep *`");
	});
});

describe("formatNudgeMessage", () => {
	it("names bash and the shell command for bash nudges", () => {
		expect(
			formatNudgeMessage(
				"bash",
				"grep foo",
				"grep *",
				"Prefer the grep tool over grep",
			),
		).toBe(
			"You ran bash `grep foo` (matched pattern `grep *`). Prefer the grep tool over grep",
		);
	});

	it("names the native tool for non-bash nudges", () => {
		expect(
			formatNudgeMessage("read", null, undefined, "use pluck_read instead"),
		).toBe("You called the `read` tool. use pluck_read instead");
	});

	it("omits the pattern clause when no pattern matched", () => {
		const msg = formatNudgeMessage("bash", "grep foo", undefined, "hint");
		expect(msg).toBe("You ran bash `grep foo`. hint");
	});

	it("truncates long bash commands", () => {
		const long = `grep ${"x".repeat(200)}`;
		const msg = formatNudgeMessage("bash", long, "grep *", "hint");
		expect(msg).toContain("…");
		expect(msg).toContain("hint");
	});

	it("notifies the UI with caller context for bash nudges", async () => {
		const config: ControlsResolvedConfig = {
			policies: {
				nudged: {
					defaultAction: "allow",
					rules: [
						{
							action: "nudge",
							tool: "bash",
							pattern: "grep *",
							message: "Prefer the grep tool over grep",
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
			decisions: null,
		};
		pendingNudges.clear();
		const ctx = makeCtx("/tmp");
		await handleToolCall(bashEvent("grep foo", "notify-nudge-1"), ctx, config);
		const calls = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBe(1);
		const text = String(calls[0][0]);
		expect(text).toContain("nudge [nudged]");
		expect(text).toContain("You ran bash `grep foo`");
		expect(text).toContain("Prefer the grep tool over grep");
	});
});

describe("piped cat nudge suppression", () => {
	const catNudgeConfig: ControlsResolvedConfig = {
		policies: {
			nudged: {
				defaultAction: "allow",
				rules: [
					{
						action: "nudge",
						tool: "bash",
						pattern: "cat *",
						message: "Prefer the read tool over cat",
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
		decisions: null,
	};

	it("nudges when cat is called directly", async () => {
		pendingNudges.clear();
		await handleToolCall(
			bashEvent("cat package.json", "pipe-cat-1"),
			makeCtx("/tmp"),
			catNudgeConfig,
		);
		const stored = pendingNudges.get("pipe-cat-1") ?? "";
		expect(stored).toContain("Prefer the read tool over cat");
		expect(stored).toContain("You ran bash `cat package.json`");
		expect(stored).toContain("matched pattern `cat *`");
	});

	it("does not nudge when cat feeds a pipeline", async () => {
		pendingNudges.clear();
		await handleToolCall(
			bashEvent(
				'cat package.json | python3 -c "import json,sys"',
				"pipe-cat-2",
			),
			makeCtx("/tmp"),
			catNudgeConfig,
		);
		expect(pendingNudges.has("pipe-cat-2")).toBe(false);
	});

	it("does not nudge when head feeds a pipeline", async () => {
		const headNudgeConfig: ControlsResolvedConfig = {
			policies: {
				nudged: {
					defaultAction: "allow",
					rules: [
						{
							action: "nudge",
							tool: "bash",
							pattern: "head *",
							message: "Prefer the read tool over head",
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
			decisions: null,
		};
		pendingNudges.clear();
		await handleToolCall(
			bashEvent("head -n 5 /tmp/foo.txt | grep bar", "pipe-cat-3"),
			makeCtx("/tmp"),
			headNudgeConfig,
		);
		expect(pendingNudges.has("pipe-cat-3")).toBe(false);
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
		decisions: null,
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
		decisions: null,
	};

	const noNudgeTimeoutConfig: ControlsResolvedConfig = {
		...nudgeTimeoutConfig,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: null,
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
		const stored = pendingNudges.get("rs-4") ?? "";
		expect(stored).toContain(nudgeMsg);
		expect(stored).toContain("You called the `read` tool");
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
			decisions: null,
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
			decisions: null,
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
		decisions: null,
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
			decisions: null,
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

describe("eval classification via Decisions API", () => {
	const realFetch = globalThis.fetch;
	let fetchCalls = 0;

	const evalConfig: ControlsResolvedConfig = {
		policies: {
			open: { defaultAction: "allow", rules: [] },
			locked: { defaultAction: "deny", rules: [] },
		},
		locations: { "/tmp": "open" },
		defaultPolicy: "locked",
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: resolveDecisions({
			tokenEnv: "PICONTROLS_TEST_TOKEN",
			url: "https://example.invalid/decisions",
		})!,
	};

	function evalAnswers(overrides: Record<string, unknown> = {}) {
		return {
			destructive: { type: "noul", noul: 0.01 },
			network: { type: "noul", noul: 0.01 },
			exec: { type: "noul", noul: 0.01 },
			inference_call: { type: "noul", noul: 0.01 },
			obfuscated: { type: "noul", noul: 0.01 },
			write_scope: {
				type: "choice",
				choice: "within",
				confidence: 0.95,
				probabilities: { within: 0.95, none: 0.05 },
			},
			read_scope: {
				type: "choice",
				choice: "ordinary",
				confidence: 0.95,
				probabilities: { ordinary: 0.95, none: 0.05 },
			},
			...overrides,
		};
	}

	function stubFetch(impl: () => Promise<Response>): void {
		globalThis.fetch = (async () => {
			fetchCalls++;
			return impl();
		}) as unknown as typeof fetch;
	}

	function stubOk(answers: Record<string, unknown>): void {
		stubFetch(async () => {
			return new Response(
				JSON.stringify({
					id: "gen-test",
					model: "test",
					provider: "Test",
					usage: { input_tokens: 10, output_tokens: 5 },
					answers,
				}),
				{ status: 200 },
			);
		});
	}

	beforeEach(() => {
		fetchCalls = 0;
		sessionAllows.clear();
		clearEvalCache();
		process.env.PICONTROLS_TEST_TOKEN = "test-token";
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.PICONTROLS_TEST_TOKEN;
		sessionAllows.clear();
		clearEvalCache();
	});

	it("allows benign evals without prompting", async () => {
		stubOk(evalAnswers());
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent('python3 -c "print(1)"', "eval-allow"),
			ctx,
			evalConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(1);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("denies dangerous evals with the rule rationale", async () => {
		stubOk(
			evalAnswers({
				destructive: { type: "noul", noul: 0.95 },
				write_scope: {
					type: "choice",
					choice: "outside",
					confidence: 0.9,
					probabilities: { outside: 0.9, within: 0.1 },
				},
			}),
		);
		const result = await handleToolCall(
			bashEvent('python3 -c "import shutil; shutil.rmtree(1)"', "eval-deny"),
			makeCtx("/tmp"),
			evalConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("destructive-concealed-or-outside"),
		});
		// An eval verdict is not a path restriction; it must not claim one.
		expect(result?.reason).not.toContain("blocked path");
		expect(result?.reason).not.toContain("restriction is on the PATH");
	});

	it("asks on out-of-scope writes and shows the rationale", async () => {
		stubOk(
			evalAnswers({
				write_scope: {
					type: "choice",
					choice: "outside",
					confidence: 0.9,
					probabilities: { outside: 0.9, within: 0.1 },
				},
			}),
		);
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent('python3 -c "open(1)"', "eval-ask"),
			ctx,
			evalConfig,
		);
		expect(result).toBeUndefined();
		const selectMock = ctx.ui.select as ReturnType<typeof mock>;
		expect(selectMock.mock.calls.length).toBe(1);
		expect(String(selectMock.mock.calls[0][0])).toContain("write-out-of-scope");
	});

	it("denies dangerous evals even where no location matches", async () => {
		stubOk(
			evalAnswers({
				read_scope: {
					type: "choice",
					choice: "sensitive",
					confidence: 0.9,
					probabilities: { sensitive: 0.9 },
				},
				network: { type: "noul", noul: 0.9 },
			}),
		);
		const openConfig: ControlsResolvedConfig = {
			...evalConfig,
			defaultPolicy: null,
		};
		const result = await handleToolCall(
			bashEvent('python3 -c "exfil()"', "eval-gap"),
			makeCtx("/home/user"),
			openConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("exfil-shape"),
		});
	});

	it("makes no fetch calls when decisions is unconfigured", async () => {
		stubOk(evalAnswers());
		const result = await handleToolCall(
			bashEvent('python3 -c "print(1)"', "eval-off"),
			makeCtx("/tmp"),
			config,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});

	it("skips classification for session-allowed commands", async () => {
		stubOk(evalAnswers());
		const command = 'python3 -c "print(1)"';
		sessionAllows.add(sessionAllowKey("bash", command, ["/tmp"]));
		const result = await handleToolCall(
			bashEvent(command, "eval-session"),
			makeCtx("/tmp"),
			evalConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});

	it("skips classification for approval-rule allows", async () => {
		stubOk(evalAnswers());
		const approvedConfig: ControlsResolvedConfig = {
			...evalConfig,
			approvalRules: [
				{ action: "allow", tool: "bash", pattern: "python3 *", policy: "open" },
			],
		};
		const result = await handleToolCall(
			bashEvent('python3 -c "print(1)"', "eval-approved"),
			makeCtx("/tmp"),
			approvedConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});

	it("asks without fetching when the source is unrecoverable", async () => {
		stubOk(evalAnswers());
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent('python3 -c "$CODE"', "eval-dynamic"),
			ctx,
			evalConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("falls back to errorAction when the API fails", async () => {
		stubFetch(async () => {
			throw new Error("boom");
		});
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			bashEvent('python3 -c "print(1)"', "eval-error"),
			ctx,
			evalConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(1);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});

	it("caches repeat classifications within the session", async () => {
		stubOk(evalAnswers());
		const command = 'python3 -c "print(1)"';
		expect(
			await handleToolCall(
				bashEvent(command, "eval-cache-1"),
				makeCtx("/tmp"),
				evalConfig,
			),
		).toBeUndefined();
		expect(
			await handleToolCall(
				bashEvent(command, "eval-cache-2"),
				makeCtx("/tmp"),
				evalConfig,
			),
		).toBeUndefined();
		expect(fetchCalls).toBe(1);
	});
});

describe("tool-call handler — symlink location resolution", () => {
	const roots: string[] = [];

	function makeRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "pi-controls-symlink-"));
		roots.push(root);
		return root;
	}

	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	// project → open (allow), .ssh → locked (deny). The link lives inside the
	// open project but resolves into the locked location.
	function symlinkConfig(project: string, ssh: string): ControlsResolvedConfig {
		return {
			policies: {
				open: { defaultAction: "allow", rules: [] },
				locked: { defaultAction: "deny", rules: [] },
			},
			locations: { [project]: "open", [ssh]: "locked" },
			defaultPolicy: "locked",
			cycleKey: "ctrl+shift+m",
			agentTimeout: null,
			nudgeTimeout: null,
			pathProtection: null,
			decisions: null,
		};
	}

	function setupSymlink(): {
		root: string;
		project: string;
		ssh: string;
	} {
		const root = makeRoot();
		const project = join(root, "project");
		const ssh = join(root, ".ssh");
		mkdirSync(project);
		mkdirSync(ssh);
		symlinkSync(ssh, join(project, "ssh"));
		return { root, project, ssh };
	}

	it("denies reading through a symlink into a locked location", async () => {
		const { project, ssh } = setupSymlink();
		const event = toolEvent("read", "symlink-read-1", {
			file_path: join(project, "ssh", "id_rsa"),
		});
		const result = await handleToolCall(
			event,
			makeCtx(project),
			symlinkConfig(project, ssh),
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("denies a bash path arg through a symlink into a locked location", async () => {
		const { project, ssh } = setupSymlink();
		const result = await handleToolCall(
			bashEvent(`cat ${join(project, "ssh", "id_rsa")}`),
			makeCtx(project),
			symlinkConfig(project, ssh),
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("still allows a regular file inside the open project", async () => {
		const { project, ssh } = setupSymlink();
		const event = toolEvent("read", "symlink-read-2", {
			file_path: join(project, "notes.txt"),
		});
		const result = await handleToolCall(
			event,
			makeCtx(project),
			symlinkConfig(project, ssh),
		);
		expect(result).toBeUndefined();
	});
});

describe("forwarded asks from subagent children", () => {
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
		decisions: null,
		cycleKey: "ctrl+shift+m",
	};

	it("asks the parent UI instead of the child's own dialog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-controls-hook-fwd-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		const childId = "hook-forward-child";
		const parentId = "hook-forward-parent";
		getSubagentSessionRegistry().register(childId, {
			parentSessionId: parentId,
		});
		getServingSessionRegistry().markServing(parentId);
		sessionAllows.clear();
		try {
			const childSelect = mock(async () => "Deny");
			const childCtx = {
				cwd: "/tmp",
				hasUI: false,
				sessionManager: {
					getSessionId: () => childId,
					getSessionDir: () => "/tmp/child-session",
				},
				ui: { notify: mock(() => {}), select: childSelect },
			} as unknown as ExtensionContext;

			const pending = handleToolCall(
				toolEvent("write", "fwd-1", { file_path: "/tmp/foo.ts" }),
				childCtx,
				askConfig,
			);

			const location = forwardingLocation(defaultForwardingDir(), parentId);
			for (
				let i = 0;
				i < 200 && listJsonFiles(location.requestsDir).length === 0;
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(listJsonFiles(location.requestsDir).length).toBe(1);

			const parentCtx = {
				cwd: "/tmp",
				hasUI: true,
				sessionManager: {
					getSessionId: () => parentId,
					getSessionDir: () => "/tmp/parent-session",
				},
				ui: {
					notify: mock(() => {}),
					select: mock(async () => "Allow"),
				},
			} as unknown as ExtensionContext;
			await new ForwardingManager({
				forwardingDir: defaultForwardingDir(),
			}).processInbox(parentCtx);

			expect(await pending).toBeUndefined();
			expect(childSelect).not.toHaveBeenCalled();
		} finally {
			getSubagentSessionRegistry().unregister(childId);
			getServingSessionRegistry().clearServing(parentId);
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports an unavailable approval rather than a user denial", async () => {
		sessionAllows.clear();
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			sessionManager: {
				getSessionId: () => "unregistered-headless-child",
				getSessionDir: () => "/tmp/headless-session",
			},
			ui: { notify: mock(() => {}), select: mock(async () => "Allow") },
		} as unknown as ExtensionContext;

		const result = await handleToolCall(
			toolEvent("write", "fwd-2", { file_path: "/tmp/foo.ts" }),
			ctx,
			askConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no interactive UI");
		expect(result?.reason).not.toContain("Blocked by user");
	});
});

describe("deny reason selects the sentence from the deciding rule", () => {
	beforeEach(() => {
		nudgeTrackers.clear();
		denyTracker.reset();
		sessionAllows.clear();
	});

	const patternDenyConfig: ControlsResolvedConfig = {
		policies: {
			guarded: {
				defaultAction: "allow",
				rules: [{ action: "deny", tool: "bash", pattern: "dd *" }],
			},
		},
		locations: { "/tmp": "guarded" },
		defaultPolicy: null,
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: null,
	};

	it("pattern deny cites the pattern and does not name the cwd as a blocked path", async () => {
		const result = await handleToolCall(
			bashEvent("dd bs=1M", "pattern-deny"),
			makeCtx("/tmp"),
			patternDenyConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('pattern: "dd *"');
		expect(result?.reason).toContain("Avoid the blocked pattern in any retry");
		expect(result?.reason).not.toContain("blocked path");
		expect(result?.reason).not.toContain("/tmp");
	});

	it("tool deny points at the tool and says another tool can still reach the path", async () => {
		const toolDenyConfig: ControlsResolvedConfig = {
			...patternDenyConfig,
			policies: {
				guarded: {
					defaultAction: "allow",
					rules: [{ action: "deny", tool: "write" }],
				},
			},
		};
		const result = await handleToolCall(
			toolEvent("write", "tool-deny", { file_path: "/tmp/foo.ts" }),
			makeCtx("/tmp"),
			toolDenyConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('restriction is on the tool "write"');
		expect(result?.reason).toContain("another tool can still reach it");
		expect(result?.reason).toContain('path: "/tmp/foo.ts"');
		expect(result?.reason).not.toContain("blocked path");
		expect(result?.reason).not.toContain("restriction is on the PATH");
	});

	it("policy default deny keeps the path restriction sentence", async () => {
		const defaultDenyConfig: ControlsResolvedConfig = {
			...patternDenyConfig,
			policies: { guarded: { defaultAction: "deny", rules: [] } },
		};
		const result = await handleToolCall(
			toolEvent("read", "default-deny", { file_path: "/tmp/foo.ts" }),
			makeCtx("/tmp"),
			defaultDenyConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("The restriction is on the PATH");
		expect(result?.reason).toContain('blocked path: "/tmp/foo.ts"');
		expect(result?.reason).toContain("all access to these paths is blocked");
	});

	it("universal tool glob deny is a path restriction", async () => {
		const universalDenyConfig: ControlsResolvedConfig = {
			...patternDenyConfig,
			policies: {
				guarded: {
					defaultAction: "allow",
					rules: [{ action: "deny", tool: "*" }],
				},
			},
		};
		const result = await handleToolCall(
			toolEvent("write", "universal-deny", { file_path: "/tmp/foo.ts" }),
			makeCtx("/tmp"),
			universalDenyConfig,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("The restriction is on the PATH");
		expect(result?.reason).toContain('blocked path: "/tmp/foo.ts"');
	});

	it("escalated bash pattern nudge uses the pattern sentence, not the path sentence", async () => {
		const escalatedPatternConfig: ControlsResolvedConfig = {
			...patternDenyConfig,
			policies: {
				guarded: {
					defaultAction: "allow",
					rules: [
						{
							action: "nudge",
							tool: "bash",
							pattern: "grep *",
							message: "Prefer the grep tool over grep",
						},
					],
				},
			},
			nudgeTimeout: { maxNudges: 2, windowSeconds: 60 },
		};
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			bashEvent("grep foo", "pn-1"),
			ctx,
			escalatedPatternConfig,
		);
		const r2 = await handleToolCall(
			bashEvent("grep bar", "pn-2"),
			ctx,
			escalatedPatternConfig,
		);
		expect(r2?.block).toBe(true);
		expect(r2?.reason).toContain('pattern: "grep *"');
		expect(r2?.reason).toContain("Avoid the blocked pattern in any retry");
		expect(r2?.reason).toContain("Prefer the grep tool over grep");
		expect(r2?.reason).not.toContain("restriction is on the PATH");
	});

	it("escalated non-bash nudge points at the tool, not the path", async () => {
		const escalatedToolConfig: ControlsResolvedConfig = {
			...patternDenyConfig,
			policies: {
				guarded: {
					defaultAction: "allow",
					rules: [
						{
							action: "nudge",
							tool: "read",
							message: "Prefer pluck_read",
						},
					],
				},
			},
			nudgeTimeout: { maxNudges: 2, windowSeconds: 60 },
		};
		const ctx = makeCtx("/tmp");
		await handleToolCall(
			toolEvent("read", "en-1", { file_path: "/tmp/a.ts" }),
			ctx,
			escalatedToolConfig,
		);
		const r2 = await handleToolCall(
			toolEvent("read", "en-2", { file_path: "/tmp/a.ts" }),
			ctx,
			escalatedToolConfig,
		);
		expect(r2?.block).toBe(true);
		expect(r2?.reason).toContain('restriction is on the tool "read"');
		expect(r2?.reason).toContain("another tool can still reach it");
		expect(r2?.reason).not.toContain("restriction is on the PATH");
	});
});
describe("auto action via Decisions API", () => {
	const realFetch = globalThis.fetch;
	let fetchCalls = 0;

	const autoConfig: ControlsResolvedConfig = {
		policies: {
			autoPolicy: { defaultAction: "auto", rules: [] },
		},
		locations: { "/tmp": "autoPolicy" },
		defaultPolicy: null,
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: resolveDecisions({
			tokenEnv: "PICONTROLS_TEST_TOKEN",
			url: "https://example.invalid/decisions",
		})!,
	};

	function autoAnswers(overrides: Record<string, unknown> = {}) {
		return {
			action_class: {
				type: "choice",
				choice: "local_read",
				confidence: 0.95,
				probabilities: { local_read: 0.95, none: 0.05 },
			},
			scope: {
				type: "choice",
				choice: "within",
				confidence: 0.95,
				probabilities: { within: 0.95, none: 0.05 },
			},
			data_sensitivity: {
				type: "choice",
				choice: "ordinary",
				confidence: 0.95,
				probabilities: { ordinary: 0.95, none: 0.05 },
			},
			destructive: { type: "noul", noul: 0.01 },
			network: { type: "noul", noul: 0.01 },
			concealed: { type: "noul", noul: 0.01 },
			inference_call: { type: "noul", noul: 0.01 },
			...overrides,
		};
	}

	function stubFetch(impl: () => Promise<Response>): void {
		globalThis.fetch = (async () => {
			fetchCalls++;
			return impl();
		}) as unknown as typeof fetch;
	}

	function stubOk(answers: Record<string, unknown>): void {
		stubFetch(
			async () =>
				new Response(
					JSON.stringify({
						id: "gen-test",
						model: "test",
						provider: "Test",
						usage: { input_tokens: 10, output_tokens: 5 },
						answers,
					}),
					{ status: 200 },
				),
		);
	}

	function evalQuestionAnswers(overrides: Record<string, unknown> = {}) {
		return {
			destructive: { type: "noul", noul: 0.01 },
			network: { type: "noul", noul: 0.01 },
			exec: { type: "noul", noul: 0.01 },
			inference_call: { type: "noul", noul: 0.01 },
			obfuscated: { type: "noul", noul: 0.01 },
			write_scope: {
				type: "choice",
				choice: "within",
				confidence: 0.95,
				probabilities: { within: 0.95, none: 0.05 },
			},
			read_scope: {
				type: "choice",
				choice: "ordinary",
				confidence: 0.95,
				probabilities: { ordinary: 0.95, none: 0.05 },
			},
			...overrides,
		};
	}

	/** Route eval vs auto answers by the question set in the request. */
	function stubRouted(
		auto: Record<string, unknown>,
		evalAnswers: Record<string, unknown>,
	): void {
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			fetchCalls++;
			const body = JSON.parse(String(init.body)) as {
				questions?: Record<string, unknown>;
			};
			const isEval = "write_scope" in (body.questions ?? {});
			return new Response(
				JSON.stringify({
					id: "gen-test",
					model: "test",
					provider: "Test",
					usage: { input_tokens: 10, output_tokens: 5 },
					answers: isEval ? evalAnswers : auto,
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
	}

	function lsEvent(id = "auto-id") {
		return toolEvent("ls", id, { path: "/tmp" });
	}

	beforeEach(() => {
		fetchCalls = 0;
		sessionAllows.clear();
		clearAutoCache();
		resetDecisionWarnings();
		process.env.PICONTROLS_TEST_TOKEN = "test-token";
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.PICONTROLS_TEST_TOKEN;
		sessionAllows.clear();
		clearAutoCache();
	});

	it("allows a benign call and resolves auto to allow", async () => {
		stubOk(autoAnswers());
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(lsEvent(), ctx, autoConfig);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(1);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			0,
		);
	});

	it("resolves auto for bash calls too", async () => {
		stubOk(autoAnswers());
		const result = await handleToolCall(
			bashEvent("ls /tmp", "auto-bash"),
			makeCtx("/tmp"),
			autoConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(1);
	});

	it("denies a destructive out-of-scope call with the rule rationale", async () => {
		stubOk(
			autoAnswers({
				destructive: { type: "noul", noul: 0.95 },
				scope: {
					type: "choice",
					choice: "outside",
					confidence: 0.9,
					probabilities: { outside: 0.9, within: 0.1 },
				},
			}),
		);
		const result = await handleToolCall(
			lsEvent("auto-deny"),
			makeCtx("/tmp"),
			autoConfig,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("destructive-out-of-scope"),
		});
	});

	it("asks (and cites the rule) on a sensitive read", async () => {
		stubOk(
			autoAnswers({
				data_sensitivity: {
					type: "choice",
					choice: "sensitive",
					confidence: 0.9,
					probabilities: { sensitive: 0.9, ordinary: 0.1 },
				},
			}),
		);
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(lsEvent("auto-ask"), ctx, autoConfig);
		expect(result).toBeUndefined();
		const selectMock = ctx.ui.select as ReturnType<typeof mock>;
		expect(selectMock.mock.calls.length).toBe(1);
		expect(String(selectMock.mock.calls[0][0])).toContain("sensitive-read");
	});

	it("caches repeat verdicts within the session", async () => {
		stubOk(autoAnswers());
		await handleToolCall(lsEvent("auto-cache-1"), makeCtx("/tmp"), autoConfig);
		await handleToolCall(lsEvent("auto-cache-2"), makeCtx("/tmp"), autoConfig);
		expect(fetchCalls).toBe(1);
	});

	it("honours a saved session allow without calling the API", async () => {
		stubOk(autoAnswers());
		sessionAllows.add(sessionAllowKey("ls", null, ["/tmp"]));
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			lsEvent("auto-session"),
			ctx,
			autoConfig,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});

	it("falls back to ask when decisions is not configured", async () => {
		stubOk(autoAnswers());
		const unconfigured: ControlsResolvedConfig = {
			...autoConfig,
			decisions: null,
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(
			lsEvent("auto-unconfigured"),
			ctx,
			unconfigured,
		);
		expect(result).toBeUndefined(); // select stub returns Allow
		expect(fetchCalls).toBe(0);
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
		expect(
			(ctx.ui.notify as ReturnType<typeof mock>).mock.calls.some((call) =>
				String(call[0]).includes("decisions"),
			),
		).toBe(true);
	});

	it("does not call the API when an explicit rule wins", async () => {
		stubOk(autoAnswers());
		const explicit: ControlsResolvedConfig = {
			...autoConfig,
			policies: {
				autoPolicy: {
					defaultAction: "auto",
					rules: [{ action: "deny", tool: "ls" }],
				},
			},
		};
		const result = await handleToolCall(
			lsEvent("auto-explicit"),
			makeCtx("/tmp"),
			explicit,
		);
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
		expect(fetchCalls).toBe(0);
	});

	it("lets a saved approval win without calling the API", async () => {
		stubOk(autoAnswers());
		const approved: ControlsResolvedConfig = {
			...autoConfig,
			approvalRules: [{ action: "allow", tool: "ls", policy: "autoPolicy" }],
		};
		const result = await handleToolCall(
			lsEvent("auto-approved"),
			makeCtx("/tmp"),
			approved,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(0);
	});

	it("still evaluates auto when only some bash stages are approved", async () => {
		stubOk(autoAnswers());
		const mixed: ControlsResolvedConfig = {
			...autoConfig,
			locations: { "/tmp": "autoPolicy", "/var": "autoPolicy" },
			approvalRules: [
				{
					action: "allow",
					tool: "bash",
					pattern: "ls /tmp*",
					policy: "autoPolicy",
				},
			],
		};
		const result = await handleToolCall(
			bashEvent("ls /tmp && ls /var", "auto-mixed"),
			makeCtx("/tmp"),
			mixed,
		);
		expect(result).toBeUndefined();
		expect(fetchCalls).toBe(1);
	});

	it("still evaluates auto when only an unrelated stage was eval-classified", async () => {
		stubRouted(autoAnswers(), evalQuestionAnswers());
		const result = await handleToolCall(
			bashEvent('python3 -c "print(1)"; ls /tmp', "auto-mixed-eval"),
			makeCtx("/tmp"),
			autoConfig,
		);
		expect(result).toBeUndefined();
		// One request for the eval stage, one for the non-eval auto stage.
		expect(fetchCalls).toBe(2);
	});

	it("does not reuse a cached verdict for truncated-but-different commands", async () => {
		stubOk(autoAnswers());
		const truncated: ControlsResolvedConfig = {
			...autoConfig,
			decisions: resolveDecisions({
				tokenEnv: "PICONTROLS_TEST_TOKEN",
				url: "https://example.invalid/decisions",
				auto: { maxInputBytes: 10 },
			})!,
		};
		await handleToolCall(
			bashEvent("echo AAAAAAAAAAA", "trunc-1"),
			makeCtx("/tmp"),
			truncated,
		);
		await handleToolCall(
			bashEvent("echo AAAAAAAAAAB", "trunc-2"),
			makeCtx("/tmp"),
			truncated,
		);
		expect(fetchCalls).toBe(2);
	});

	it("caps an errorAction deny at ask when deny is disabled", async () => {
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const capped: ControlsResolvedConfig = {
			...autoConfig,
			decisions: resolveDecisions({
				tokenEnv: "PICONTROLS_TEST_TOKEN",
				url: "https://example.invalid/decisions",
				errorAction: "deny",
				auto: { deny: false },
			})!,
		};
		const ctx = makeCtx("/tmp");
		const result = await handleToolCall(lsEvent("auto-err-cap"), ctx, capped);
		expect(result).toBeUndefined(); // select stub returned Allow
		expect((ctx.ui.select as ReturnType<typeof mock>).mock.calls.length).toBe(
			1,
		);
	});
});
