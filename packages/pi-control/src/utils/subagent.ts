/**
 * Subagent detection and forwarding-target resolution.
 *
 * pi-control asks the user before running an `ask`-classified tool call. In a
 * subagent child session there is no UI to ask, so the child writes the ask to
 * its parent's forwarded-request inbox instead. This module owns the two facts
 * that path needs:
 *
 *   1. Is the current session a subagent child?
 *   2. Which session should its asks be forwarded to?
 *
 * Both answers have to survive pi's per-extension, per-session jiti isolation
 * (`moduleCache: false`). Each session's resource loader creates its own event
 * bus, so the parent's pi-control instance never receives the child's events and
 * vice versa. The parent learns about children by subscribing to the child
 * lifecycle events `@gotgenes/pi-subagents` publishes on its own bus, and stores
 * them in a process-global registry keyed by child session id — `globalThis` +
 * `Symbol.for()` is the only state two sessions in one process share.
 *
 * The convention mirrored here is documented by `@gotgenes/pi-permission-system`
 * (`docs/subagent-integration.md`): in-process implementations emit
 * `subagents:child:session-created`/`disposed`; out-of-process implementations
 * set `PI_SUBAGENT_PARENT_SESSION`. Detection never depends on either package
 * being installed.
 */

// ── Event channels ────────────────────────────────────────────────────────────

/** Emitted by an in-process subagent core after the child session is created. */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";

/** Emitted by an in-process subagent core in the run's `finally`. */
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

// ── Process-global slots ──────────────────────────────────────────────────────

const SUBAGENT_REGISTRY_KEY = Symbol.for(
	"@mcowger/pi-control:subagent-registry",
);
const SERVING_REGISTRY_KEY = Symbol.for("@mcowger/pi-control:serving-registry");

/** Signal stored for each registered in-process subagent session. */
export interface SubagentSessionInfo {
	/** Parent session id to forward asks to. Omitted when the spawner had none. */
	parentSessionId?: string;
}

/**
 * Registry of active in-process subagent sessions, keyed by child session id.
 *
 * Written by the parent's pi-control instance from the child lifecycle events;
 * read by each child's own instance to detect itself and resolve its parent.
 * Two concurrent siblings have distinct session ids, so one sibling's disposed
 * event cannot evict another's entry.
 */
export class SubagentSessionRegistry {
	private readonly sessions = new Map<string, SubagentSessionInfo>();

	register(sessionId: string, info: SubagentSessionInfo): void {
		this.sessions.set(sessionId, info);
	}

	unregister(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	get(sessionId: string): SubagentSessionInfo | undefined {
		return this.sessions.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	get size(): number {
		return this.sessions.size;
	}
}

/**
 * Process-global child registry.
 *
 * Deliberately has no teardown hook: a child's `session_shutdown` must not be
 * able to wipe the parent's registrations.
 */
export function getSubagentSessionRegistry(): SubagentSessionRegistry {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[SUBAGENT_REGISTRY_KEY] as
		| SubagentSessionRegistry
		| undefined;
	if (existing) return existing;
	const registry = new SubagentSessionRegistry();
	store[SUBAGENT_REGISTRY_KEY] = registry;
	return registry;
}

/**
 * Sessions currently draining a forwarded-ask inbox.
 *
 * A session with a UI marks itself while its poller runs; an in-process child
 * checks that mark before committing to a wait, so a parent that has stopped
 * polling is abandoned after a short grace window instead of the full timeout.
 * Out-of-process children cannot see this and use the filesystem heartbeat
 * instead (see `forwarding-io.ts`).
 */
export class ServingSessionRegistry {
	private readonly serving = new Set<string>();

	markServing(sessionId: string): void {
		this.serving.add(sessionId);
	}

	clearServing(sessionId: string): void {
		this.serving.delete(sessionId);
	}

	isServing(sessionId: string): boolean {
		return this.serving.has(sessionId);
	}

	servingIds(): readonly string[] {
		return [...this.serving];
	}
}

/** Process-global serving registry. */
export function getServingSessionRegistry(): ServingSessionRegistry {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[SERVING_REGISTRY_KEY] as
		| ServingSessionRegistry
		| undefined;
	if (existing) return existing;
	const registry = new ServingSessionRegistry();
	store[SERVING_REGISTRY_KEY] = registry;
	return registry;
}

// ── Child lifecycle subscription ──────────────────────────────────────────────

/** Minimal event-bus surface needed to observe the child lifecycle. */
export interface LifecycleEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Payload fields read from `subagents:child:session-created`. */
export interface ChildSessionCreatedEvent {
	sessionId: string;
	parentSessionId?: string;
}

/** Payload fields read from `subagents:child:disposed`. */
export interface ChildDisposedEvent {
	sessionId: string;
}

/**
 * Register children on `session-created` and unregister them on `disposed`.
 *
 * The `session-created` handler must stay synchronous: the core emits it on the
 * same call stack immediately before binding child extensions, and the child's
 * own pi-control instance reads this registry during its `session_start`.
 *
 * @returns an unsubscribe that detaches both handlers.
 */
export function subscribeSubagentLifecycle(
	events: LifecycleEventBus,
	registry: SubagentSessionRegistry,
): () => void {
	const unsubscribeCreated = events.on(
		SUBAGENT_CHILD_SESSION_CREATED,
		(data) => {
			const event = data as ChildSessionCreatedEvent;
			if (typeof event?.sessionId !== "string" || !event.sessionId) return;
			registry.register(event.sessionId, {
				parentSessionId: event.parentSessionId,
			});
		},
	);
	const unsubscribeDisposed = events.on(SUBAGENT_CHILD_DISPOSED, (data) => {
		const event = data as ChildDisposedEvent;
		if (typeof event?.sessionId !== "string") return;
		registry.unregister(event.sessionId);
	});
	return () => {
		unsubscribeCreated();
		unsubscribeDisposed();
	};
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Ordered parent-session env var names. First match wins.
 *
 * `PI_AGENT_ROUTER_PARENT_SESSION_ID` predates the shared convention;
 * `PI_SUBAGENT_PARENT_SESSION` is the convention every CLI-based subagent
 * extension is asked to set.
 */
export const SUBAGENT_PARENT_SESSION_ENV_CANDIDATES: readonly string[] = [
	"PI_AGENT_ROUTER_PARENT_SESSION_ID",
	"PI_SUBAGENT_PARENT_SESSION",
];

/** Markers other process-based subagent extensions set on their children. */
const THIRD_PARTY_SUBAGENT_ENV_HINTS: readonly string[] = [
	"PI_IS_SUBAGENT",
	"PI_SUBAGENT_SESSION_ID",
	"PI_AGENT_ROUTER_SUBAGENT",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_ID",
	"PI_SUBAGENT_SESSION",
];

/** Env vars whose presence marks the current process as a subagent child. */
export const SUBAGENT_ENV_HINT_KEYS: readonly string[] = [
	...THIRD_PARTY_SUBAGENT_ENV_HINTS,
	...SUBAGENT_PARENT_SESSION_ENV_CANDIDATES,
];

/** The only session-manager readers detection needs. */
export interface SubagentDetectionContext {
	sessionManager?: {
		getSessionId?(): string;
		getSessionDir?(): string;
	};
}

function safelyRead(
	owner: SubagentDetectionContext["sessionManager"],
	method: "getSessionId" | "getSessionDir",
): string | null {
	const read = owner?.[method];
	if (typeof read !== "function") return null;
	try {
		const value = read.call(owner);
		return typeof value === "string" && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

/** The current session id, or `null` when the host exposes none. */
export function readSessionId(ctx: SubagentDetectionContext): string | null {
	return safelyRead(ctx.sessionManager, "getSessionId");
}

/** The current session directory, or `null` when the host exposes none. */
export function readSessionDir(ctx: SubagentDetectionContext): string | null {
	return safelyRead(ctx.sessionManager, "getSessionDir");
}

/**
 * `@gotgenes/pi-subagents` nests child sessions under
 * `<parent-dir>/<parent-basename>/tasks`, so a session whose directory ends in
 * a `tasks` segment is a child of that core. Used only as a fallback.
 */
function isUnderSubagentSessionsDir(sessionDir: string | null): boolean {
	if (!sessionDir) return false;
	const segments = sessionDir.split(/[/\\]+/).filter(Boolean);
	return segments.length > 0 && segments[segments.length - 1] === "tasks";
}

/**
 * Whether the current session is a subagent child.
 *
 * Registry first (deterministic for in-process children), then env hints
 * (process-based children), then the session-directory fallback.
 */
export function isSubagentContext(
	ctx: SubagentDetectionContext,
	registry: SubagentSessionRegistry,
): boolean {
	const sessionId = readSessionId(ctx);
	if (sessionId && registry.has(sessionId)) return true;

	for (const key of SUBAGENT_ENV_HINT_KEYS) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim()) return true;
	}

	return isUnderSubagentSessionsDir(readSessionDir(ctx));
}

// ── Target resolution ─────────────────────────────────────────────────────────

/** How a forwarding target was found. */
export type ForwardingTargetSource = "registry" | "env";

/** The session a child forwards its asks to. */
export interface ForwardingTarget {
	sessionId: string;
	source: ForwardingTargetSource;
}

/** Trim a candidate session id, rejecting the unusable sentinels. */
export function normalizeSessionId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
	return trimmed;
}

/**
 * Resolve the session this child forwards asks to, or `null` when it has none.
 *
 * Answers only "which *other* session": a candidate naming the requester itself
 * is ignored, because a request filed into one's own inbox is drained by no
 * watcher.
 */
export function resolveForwardingTarget(options: {
	isSubagent: boolean;
	currentSessionId?: string | null;
	sessionId?: string | null;
	env?: NodeJS.ProcessEnv;
	registry?: SubagentSessionRegistry;
}): ForwardingTarget | null {
	if (!options.isSubagent) return null;

	const own = normalizeSessionId(options.currentSessionId);
	const namesAnotherSession = (candidate: string): boolean => candidate !== own;

	if (options.registry && options.sessionId) {
		const entry = options.registry.get(options.sessionId);
		const resolved = normalizeSessionId(entry?.parentSessionId);
		if (resolved && namesAnotherSession(resolved)) {
			return { sessionId: resolved, source: "registry" };
		}
	}

	const env = options.env ?? process.env;
	for (const key of SUBAGENT_PARENT_SESSION_ENV_CANDIDATES) {
		const resolved = normalizeSessionId(env[key]);
		if (resolved && namesAnotherSession(resolved)) {
			return { sessionId: resolved, source: "env" };
		}
	}
	return null;
}
