import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getControlsModeStore } from "../src/utils/controls-mode.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	handlers: Map<string, Handler>;
	commands: Map<string, (args: string, ctx: unknown) => unknown>;
}

/**
 * Load a fresh instance of the extension, the way Pi loads one per session
 * (jiti isolation, `moduleCache: false`). The cache-busted specifier stands in
 * for a second session's copy of the module.
 */
async function instantiateExtension(sessionTag: string): Promise<FakePi> {
	const fake: FakePi = { handlers: new Map(), commands: new Map() };
	const module = (await import(
		`../src/index.js?session=${sessionTag}`
	)) as typeof import("../src/index.js");

	const pi = {
		events: { on: () => () => {} },
		getAllTools: () => [],
		appendEntry: () => {},
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: unknown) => unknown },
		) => {
			fake.commands.set(name, options.handler);
		},
		on: (name: string, handler: Handler) => {
			fake.handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	await module.default(pi);
	return fake;
}

function makeCommandCtx(): any {
	return {
		ui: {
			setWidget: () => {},
			notify: () => {},
			select: async () => undefined,
		},
	};
}

/** Minimal context for a denied bash call (a locked default policy). */
function makeToolCtx(): any {
	return {
		cwd: "/home/user",
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => "Deny",
			setStatus: () => {},
			theme: { fg: (_c: string, text: string) => text, bold: (t: string) => t },
		},
		sessionManager: {
			getSessionId: () => "index-test-session",
			getBranch: () => [],
		},
	};
}

function bashEvent(command: string, id: string): unknown {
	return {
		type: "tool_call",
		toolCallId: id,
		toolName: "bash",
		input: { command },
	};
}

describe("pi-controls mode propagation across sessions", () => {
	let tmpAgentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-controls-index-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		mkdirSync(join(tmpAgentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(tmpAgentDir, "extensions", "pi-controls.jsonc"),
			JSON.stringify({
				policies: { locked: { defaultAction: "deny", rules: [] } },
				defaultPolicy: "locked",
			}),
		);
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(tmpAgentDir, { recursive: true, force: true });
		getControlsModeStore().set("enforce");
	});

	it("applies the parent's ignore mode to an in-process child session", async () => {
		const parent = await instantiateExtension("parent");
		const child = await instantiateExtension("child");
		const childToolCall = child.handlers.get("tool_call");
		expect(childToolCall).toBeDefined();

		// Enforce: the child's own instance blocks the call.
		const blocked = await childToolCall?.(
			bashEvent("git status", "call-before-ignore"),
			makeToolCtx(),
		);
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});

		// The parent switches to ignore; the child must see the shared mode and
		// skip evaluation instead of escalating through its own instance.
		await parent.commands.get("controls")?.("ignore", makeCommandCtx());

		const skipped = await childToolCall?.(
			bashEvent("git status", "call-after-ignore"),
			makeToolCtx(),
		);
		expect(skipped).toBeUndefined();
	});
});
