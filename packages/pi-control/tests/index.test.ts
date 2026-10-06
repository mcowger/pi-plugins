import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getControlsModeStore } from "../src/utils/controls-mode.js";
import { getSubagentSessionRegistry } from "../src/utils/subagent.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	handlers: Map<string, Handler>;
	commands: Map<string, (args: string, ctx: unknown) => unknown>;
	/** setWidget calls made by this instance, in order. */
	widgets: Array<{ id: string; lines: string[] }>;
}

/**
 * Load a fresh instance of the extension, the way Pi loads one per session
 * (jiti isolation, `moduleCache: false`). The cache-busted specifier stands in
 * for a session's own copy of the module.
 */
async function instantiateExtension(sessionTag: string): Promise<FakePi> {
	const fake: FakePi = {
		handlers: new Map(),
		commands: new Map(),
		widgets: [],
	};
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

/** A session context for `session_start` and command handlers. */
function makeSessionCtx(sessionId: string, fake: FakePi): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/home/user",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionDir: () => `/tmp/${sessionId}`,
		},
		ui: {
			setWidget: (id: string, lines: string[]) => {
				fake.widgets.push({ id, lines });
			},
			notify: () => {},
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;
}

async function startSession(
	fake: FakePi,
	ctx: ExtensionContext,
): Promise<void> {
	const handler = fake.handlers.get("session_start");
	expect(handler).toBeDefined();
	await handler?.({ type: "session_start" }, ctx);
}

async function shutdownSession(fake: FakePi): Promise<void> {
	await fake.handlers.get("session_shutdown")?.(
		{ type: "session_shutdown" },
		{},
	);
}

/** Minimal context for a denied bash call (a locked default policy). */
function makeToolCtx(sessionId: string): any {
	return {
		cwd: "/home/user",
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => "Deny",
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, text: string) => text, bold: (t: string) => t },
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionDir: () => `/tmp/${sessionId}`,
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

async function callTool(
	fake: FakePi,
	sessionId: string,
	id: string,
): Promise<unknown> {
	const handler = fake.handlers.get("tool_call");
	expect(handler).toBeDefined();
	return handler?.(bashEvent("git status", id), makeToolCtx(sessionId));
}

async function setMode(
	fake: FakePi,
	ctx: ExtensionContext,
	mode: string,
): Promise<void> {
	await fake.commands.get("controls")?.(mode, ctx);
}

function registerChild(childId: string, parentId: string): void {
	getSubagentSessionRegistry().register(childId, {
		parentSessionId: parentId,
	});
}

describe("pi-controls mode propagation across sessions", () => {
	let tmpAgentDir: string;
	let previousAgentDir: string | undefined;
	const registeredChildren: string[] = [];
	const modes = ["session-a", "session-b", "child-a", ""];

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
		for (const id of registeredChildren.splice(0)) {
			getSubagentSessionRegistry().unregister(id);
		}
		const store = getControlsModeStore();
		for (const scope of modes) store.clear(scope);
	});

	it("applies the parent's ignore mode to an in-process child session", async () => {
		const parent = await instantiateExtension("parent");
		const parentCtx = makeSessionCtx("session-a", parent);
		await startSession(parent, parentCtx);

		registerChild("child-a", "session-a");
		registeredChildren.push("child-a");
		const child = await instantiateExtension("child");
		const childCtx = makeSessionCtx("child-a", child);
		await startSession(child, childCtx);

		// Enforce: the child's own instance blocks the call.
		const blocked = await callTool(child, "child-a", "call-before-ignore");
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});

		// The parent switches to ignore; the child shares the parent's lineage
		// scope and must skip evaluation instead of escalating through its own
		// instance.
		await setMode(parent, parentCtx, "ignore");

		const skipped = await callTool(child, "child-a", "call-after-ignore");
		expect(skipped).toBeUndefined();
	});

	it("keeps unrelated top-level sessions independent", async () => {
		const sessionA = await instantiateExtension("a");
		const ctxA = makeSessionCtx("session-a", sessionA);
		await startSession(sessionA, ctxA);

		const sessionB = await instantiateExtension("b");
		const ctxB = makeSessionCtx("session-b", sessionB);
		await startSession(sessionB, ctxB);

		await setMode(sessionA, ctxA, "ignore");

		// A is ignored, but B is an unrelated top-level session and must still
		// enforce the locked default policy.
		expect(await callTool(sessionA, "session-a", "a-1")).toBeUndefined();
		expect(await callTool(sessionB, "session-b", "b-1")).toEqual({
			block: true,
			reason: expect.stringContaining("Access denied"),
		});
	});

	it("does not show the IGNORE widget in a session initialized later", async () => {
		const sessionA = await instantiateExtension("a");
		const ctxA = makeSessionCtx("session-a", sessionA);
		await startSession(sessionA, ctxA);
		await setMode(sessionA, ctxA, "ignore");
		expect(sessionA.widgets.at(-1)?.lines).toEqual(["[pi-controls: IGNORE]"]);

		// B initializes after A switched to ignore: it must restore its own
		// default (no widget), not read A's mode.
		const sessionB = await instantiateExtension("b");
		const ctxB = makeSessionCtx("session-b", sessionB);
		await startSession(sessionB, ctxB);
		expect(sessionB.widgets.at(-1)?.lines).toEqual([]);

		// A's own widget is untouched by B's initialization.
		expect(sessionA.widgets.at(-1)?.lines).toEqual(["[pi-controls: IGNORE]"]);
	});

	it("does not let another session's mode change or shutdown affect a session", async () => {
		const sessionA = await instantiateExtension("a");
		const ctxA = makeSessionCtx("session-a", sessionA);
		await startSession(sessionA, ctxA);

		const sessionB = await instantiateExtension("b");
		const ctxB = makeSessionCtx("session-b", sessionB);
		await startSession(sessionB, ctxB);

		await setMode(sessionA, ctxA, "ignore");
		await setMode(sessionB, ctxB, "inform");

		// B changing to inform must not resurrect enforcement in A.
		expect(await callTool(sessionA, "session-a", "a-1")).toBeUndefined();

		await shutdownSession(sessionB);

		// B shutting down must leave A's mode in place.
		expect(await callTool(sessionA, "session-a", "a-2")).toBeUndefined();
		expect(sessionA.widgets.at(-1)?.lines).toEqual(["[pi-controls: IGNORE]"]);
	});

	it("does not clear a parent's mode when its child shuts down", async () => {
		const parent = await instantiateExtension("parent");
		const parentCtx = makeSessionCtx("session-a", parent);
		await startSession(parent, parentCtx);

		registerChild("child-a", "session-a");
		registeredChildren.push("child-a");
		const child = await instantiateExtension("child");
		const childCtx = makeSessionCtx("child-a", child);
		await startSession(child, childCtx);

		await setMode(parent, parentCtx, "ignore");
		await shutdownSession(child);

		// The child's shutdown must not delete the parent's lineage mode.
		expect(await callTool(parent, "session-a", "a-1")).toBeUndefined();
	});
});
