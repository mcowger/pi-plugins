import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	forwardAsk,
	ForwardingManager,
	promptSelect,
	resolveTargetForContext,
} from "../../src/utils/forwarding.js";
import {
	defaultForwardingDir,
	forwardingLocation,
	listJsonFiles,
	readJsonFile,
	ServingHeartbeatStore,
	STALE_AFTER_MS,
	writeJsonAtomic,
} from "../../src/utils/forwarding-io.js";
import {
	getServingSessionRegistry,
	getSubagentSessionRegistry,
	isSubagentContext,
	resolveForwardingTarget,
	subscribeSubagentLifecycle,
	type LifecycleEventBus,
} from "../../src/utils/subagent.js";

const tmpDirs: string[] = [];
const registeredIds: string[] = [];
const servingIds: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-controls-fwd-"));
	tmpDirs.push(dir);
	return dir;
}

function registerChild(sessionId: string, parentSessionId?: string): void {
	getSubagentSessionRegistry().register(sessionId, { parentSessionId });
	registeredIds.push(sessionId);
}

function markServing(sessionId: string): void {
	getServingSessionRegistry().markServing(sessionId);
	servingIds.push(sessionId);
}

afterEach(() => {
	for (const id of registeredIds.splice(0)) {
		getSubagentSessionRegistry().unregister(id);
	}
	for (const id of servingIds.splice(0)) {
		getServingSessionRegistry().clearServing(id);
	}
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeCtx(options: {
	sessionId?: string;
	hasUI?: boolean;
	select?: () => Promise<string | undefined>;
	sessionDir?: string;
}): ExtensionContext {
	return {
		hasUI: options.hasUI ?? false,
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => options.sessionId ?? "unknown-session",
			getSessionDir: () => options.sessionDir ?? "/tmp/session",
			getSessionName: () => undefined,
		},
		ui: {
			select: mock(options.select ?? (async () => undefined)),
			notify: mock(() => {}),
		},
	} as unknown as ExtensionContext;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("subagent registry", () => {
	it("registers, reads, and unregisters children", () => {
		const registry = getSubagentSessionRegistry();
		registry.register("child-a", { parentSessionId: "parent-a" });
		expect(registry.has("child-a")).toBe(true);
		expect(registry.get("child-a")?.parentSessionId).toBe("parent-a");
		registry.unregister("child-a");
		expect(registry.has("child-a")).toBe(false);
	});

	it("returns one process-global instance", () => {
		expect(getSubagentSessionRegistry()).toBe(getSubagentSessionRegistry());
		expect(getServingSessionRegistry()).toBe(getServingSessionRegistry());
	});

	it("tests for non-empty session ids", () => {
		const registry = getSubagentSessionRegistry();
		registry.register("child-b", {});
		expect(registry.has("child-b")).toBe(true);
		registry.unregister("child-b");
	});
});

describe("subagent lifecycle subscription", () => {
	function fakeBus(): {
		bus: LifecycleEventBus;
		emit: (channel: string, data: unknown) => void;
	} {
		const handlers = new Map<string, Set<(data: unknown) => void>>();
		return {
			bus: {
				on(channel, handler) {
					const set = handlers.get(channel) ?? new Set();
					set.add(handler);
					handlers.set(channel, set);
					return () => set.delete(handler);
				},
			},
			emit(channel, data) {
				for (const handler of handlers.get(channel) ?? []) handler(data);
			},
		};
	}

	it("registers on session-created and unregisters on disposed", () => {
		const registry = getSubagentSessionRegistry();
		const { bus, emit } = fakeBus();
		const unsubscribe = subscribeSubagentLifecycle(bus, registry);

		emit("subagents:child:session-created", {
			sessionId: "child-c",
			parentSessionId: "parent-c",
		});
		expect(registry.get("child-c")?.parentSessionId).toBe("parent-c");

		emit("subagents:child:disposed", { sessionId: "child-c" });
		expect(registry.has("child-c")).toBe(false);

		unsubscribe();
		emit("subagents:child:session-created", { sessionId: "child-d" });
		expect(registry.has("child-d")).toBe(false);
	});
});

describe("subagent detection", () => {
	it("detects a registered in-process child", () => {
		registerChild("child-detect");
		expect(
			isSubagentContext(
				makeCtx({ sessionId: "child-detect" }),
				getSubagentSessionRegistry(),
			),
		).toBe(true);
	});

	it("detects a child from the session-directory layout", () => {
		expect(
			isSubagentContext(
				makeCtx({ sessionDir: "/home/x/sessions/--proj--/abc/tasks" }),
				getSubagentSessionRegistry(),
			),
		).toBe(true);
	});

	it("treats an ordinary session as a root", () => {
		expect(
			isSubagentContext(
				makeCtx({ sessionId: "root", sessionDir: "/home/x/sessions/--proj--" }),
				getSubagentSessionRegistry(),
			),
		).toBe(false);
	});

	it("detects a child from environment hints", () => {
		const previous = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		try {
			expect(
				isSubagentContext(
					makeCtx({ sessionId: "child-env" }),
					getSubagentSessionRegistry(),
				),
			).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
		}
	});
});

describe("forwarding target resolution", () => {
	it("resolves the parent from the in-process registry", () => {
		registerChild("child-target", "parent-target");
		expect(
			resolveForwardingTarget({
				isSubagent: true,
				currentSessionId: "child-target",
				sessionId: "child-target",
				registry: getSubagentSessionRegistry(),
			}),
		).toEqual({ sessionId: "parent-target", source: "registry" });
	});

	it("resolves the parent from the environment", () => {
		const previous = process.env.PI_SUBAGENT_PARENT_SESSION;
		process.env.PI_SUBAGENT_PARENT_SESSION = "parent-env";
		try {
			expect(
				resolveForwardingTarget({
					isSubagent: true,
					currentSessionId: "child-env-target",
					registry: getSubagentSessionRegistry(),
				}),
			).toEqual({ sessionId: "parent-env", source: "env" });
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
			else process.env.PI_SUBAGENT_PARENT_SESSION = previous;
		}
	});

	it("ignores a target naming the requester itself", () => {
		expect(
			resolveForwardingTarget({
				isSubagent: true,
				currentSessionId: "same",
				sessionId: "same",
				env: { PI_SUBAGENT_PARENT_SESSION: "same" } as NodeJS.ProcessEnv,
			}),
		).toBeNull();
	});

	it("returns null for a non-subagent", () => {
		expect(
			resolveForwardingTarget({ isSubagent: false, currentSessionId: "x" }),
		).toBeNull();
	});
});

describe("ask forwarding round trip", () => {
	it("forwards an ask to the parent and returns its answer", async () => {
		const dir = tmpDir();
		registerChild("child-rt", "parent-rt");
		markServing("parent-rt");
		const childCtx = makeCtx({ sessionId: "child-rt" });
		const parentCtx = makeCtx({
			sessionId: "parent-rt",
			hasUI: true,
			select: async () => "Allow for session",
		});

		const target = resolveTargetForContext(childCtx);
		expect(target).toEqual({ sessionId: "parent-rt", source: "registry" });

		const pending = forwardAsk(
			childCtx,
			target as NonNullable<typeof target>,
			{ title: "Allow bash?", choices: ["Allow", "Allow for session", "Deny"] },
			{ forwardingDir: dir, pollIntervalMs: 5, timeoutMs: 2000 },
		);

		const location = forwardingLocation(dir, "parent-rt");
		await waitFor(() => listJsonFiles(location.requestsDir).length === 1);
		await new ForwardingManager({ forwardingDir: dir }).processInbox(parentCtx);
		const result = await pending;

		expect(result).toEqual({ forwarded: true, choice: "Allow for session" });
		expect(existsSync(location.requestsDir)).toBe(false);
		expect(existsSync(location.responsesDir)).toBe(false);
	});

	it("returns a null choice when the human dismisses the prompt", async () => {
		const dir = tmpDir();
		registerChild("child-dismiss", "parent-dismiss");
		markServing("parent-dismiss");
		const childCtx = makeCtx({ sessionId: "child-dismiss" });
		const parentCtx = makeCtx({
			sessionId: "parent-dismiss",
			hasUI: true,
			select: async () => undefined,
		});

		const pending = forwardAsk(
			childCtx,
			{ sessionId: "parent-dismiss", source: "registry" },
			{ title: "Allow?", choices: ["Allow", "Deny"] },
			{ forwardingDir: dir, pollIntervalMs: 5, timeoutMs: 2000 },
		);
		const location = forwardingLocation(dir, "parent-dismiss");
		await waitFor(() => listJsonFiles(location.requestsDir).length === 1);
		await new ForwardingManager({ forwardingDir: dir }).processInbox(parentCtx);

		expect(await pending).toEqual({ forwarded: true, choice: null });
	});

	it("rejects a response naming a choice the child never offered", async () => {
		const dir = tmpDir();
		registerChild("child-forge", "parent-forge");
		markServing("parent-forge");
		const childCtx = makeCtx({ sessionId: "child-forge" });
		const location = forwardingLocation(dir, "parent-forge");

		const pending = forwardAsk(
			childCtx,
			{ sessionId: "parent-forge", source: "registry" },
			{ title: "Allow?", choices: ["Allow", "Deny"] },
			{ forwardingDir: dir, pollIntervalMs: 5, timeoutMs: 2000 },
		);
		await waitFor(() => listJsonFiles(location.requestsDir).length === 1);
		const request = readJsonFile(
			join(location.requestsDir, listJsonFiles(location.requestsDir)[0] ?? ""),
		) as { id: string };
		writeJsonAtomic(join(location.responsesDir, `${request.id}.json`), {
			choice: "Allow Everything Forever",
			responderSessionId: "parent-forge",
			respondedAt: Date.now(),
		});

		expect(await pending).toEqual({ forwarded: true, choice: null });
	});

	it("abandons a target that is not serving", async () => {
		const dir = tmpDir();
		registerChild("child-unserved", "parent-unserved");
		const childCtx = makeCtx({ sessionId: "child-unserved" });

		const result = await forwardAsk(
			childCtx,
			{ sessionId: "parent-unserved", source: "registry" },
			{ title: "Allow?", choices: ["Allow", "Deny"] },
			{
				forwardingDir: dir,
				pollIntervalMs: 5,
				servingGraceMs: 25,
				timeoutMs: 2000,
			},
		);

		expect(result.forwarded).toBe(false);
		expect(result.reason).toContain("not serving");
	});

	it("gives up when a serving target never answers", async () => {
		const dir = tmpDir();
		registerChild("child-silent", "parent-silent");
		markServing("parent-silent");
		const childCtx = makeCtx({ sessionId: "child-silent" });

		const result = await forwardAsk(
			childCtx,
			{ sessionId: "parent-silent", source: "registry" },
			{ title: "Allow?", choices: ["Allow", "Deny"] },
			{ forwardingDir: dir, pollIntervalMs: 5, timeoutMs: 40 },
		);

		expect(result.forwarded).toBe(false);
		expect(result.reason).toContain("did not answer");
	});
});

describe("promptSelect", () => {
	it("prompts locally for a root session", async () => {
		const select = mock(async () => "Allow");
		const ctx = makeCtx({ sessionId: "root-select", select });
		const ctxWithUI = { ...ctx, hasUI: true } as ExtensionContext;
		expect(await promptSelect(ctxWithUI, "Allow?", ["Allow", "Deny"])).toEqual({
			choice: "Allow",
		});
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("reports an unavailable prompt without a dialog when the session has no UI and no parent", async () => {
		const select = mock(async () => "Allow");
		const ctx = makeCtx({ sessionId: "headless-root", select });
		const outcome = await promptSelect(ctx, "Allow?", ["Allow", "Deny"]);
		expect(outcome.choice).toBeUndefined();
		expect(outcome.unavailableReason).toBeTruthy();
		expect(select).not.toHaveBeenCalled();
	});

	it("forwards instead of prompting locally for a child", async () => {
		const dir = tmpDir();
		// A child that also has a UI still forwards: authority stays with the parent.
		registerChild("child-prompt", "parent-prompt");
		markServing("parent-prompt");
		const select = mock(async () => "Local");
		const childCtx = {
			...makeCtx({ sessionId: "child-prompt", select }),
			hasUI: true,
		} as ExtensionContext;
		const parentCtx = makeCtx({
			sessionId: "parent-prompt",
			hasUI: true,
			select: async () => "Allow",
		});

		// The child does not know the test's forwarding dir, so drive the
		// exchange through the same default location the code would use.
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const pending = promptSelect(childCtx, "Allow?", ["Allow", "Deny"]);
			const location = forwardingLocation(
				defaultForwardingDir(),
				"parent-prompt",
			);
			await waitFor(() => listJsonFiles(location.requestsDir).length === 1);
			await new ForwardingManager({
				forwardingDir: defaultForwardingDir(),
			}).processInbox(parentCtx);

			expect((await pending).choice).toBe("Allow");
			expect(select).not.toHaveBeenCalled();
		} finally {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
		}
	});
});

describe("serving heartbeat", () => {
	it("publishes, reads, and withdraws a heartbeat", () => {
		const dir = tmpDir();
		const store = new ServingHeartbeatStore(dir, {
			refreshMs: 1000,
			now: () => 1000,
			pid: 4242,
			isProcessAlive: () => true,
		});
		store.markServing("serving-one");
		expect(store.read("serving-one")).toBe("alive");
		expect(store.servingIds()).toContain("serving-one");
		store.clearServing("serving-one");
		expect(store.read("serving-one")).toBe("absent");
	});

	it("classifies stale and dead-pid records", () => {
		const dir = tmpDir();
		const writer = new ServingHeartbeatStore(dir, {
			refreshMs: 1000,
			now: () => 1000,
			pid: 4242,
			isProcessAlive: () => true,
		});
		writer.markServing("serving-two");

		const stale = new ServingHeartbeatStore(dir, {
			refreshMs: 1000,
			now: () => 1000 + STALE_AFTER_MS + 1,
			pid: 4242,
			isProcessAlive: () => true,
		});
		expect(stale.read("serving-two")).toBe("stale");

		const dead = new ServingHeartbeatStore(dir, {
			refreshMs: 1000,
			now: () => 1000,
			pid: 4242,
			isProcessAlive: () => false,
		});
		expect(dead.read("serving-two")).toBe("dead_pid");
	});
});
