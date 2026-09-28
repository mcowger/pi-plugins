/**
 * Filesystem transport for forwarded asks.
 *
 * A child session with no UI cannot prompt; it writes a request file into its
 * parent's inbox and polls for a response file. The parent session's poller
 * reads requests, shows the dialog, and writes the response. The filesystem is
 * the only channel an in-process child *and* a subprocess child both share.
 *
 * Layout, under the pi-control extension directory:
 *
 *   forwarding/
 *     sessions/<encoded-session-id>/requests/<request-id>.json
 *     sessions/<encoded-session-id>/responses/<request-id>.json
 *     serving/<encoded-session-id>.json      (heartbeat)
 *
 * `serving/` sits beside `sessions/`, never inside it, so a heartbeat cannot
 * keep a session root from being cleaned up once its requests are drained.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const FORWARDING_DIRECTORY_NAME = "pi-controls-forwarding";
const SESSIONS_DIRECTORY_NAME = "sessions";
const REQUESTS_DIRECTORY_NAME = "requests";
const RESPONSES_DIRECTORY_NAME = "responses";
const SERVING_DIRECTORY_NAME = "serving";
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/** Default root for forwarded-ask state: `<agentDir>/extensions/pi-controls-forwarding`. */
export function defaultForwardingDir(): string {
	return join(getAgentDir(), "extensions", FORWARDING_DIRECTORY_NAME);
}

/** Encode a session id so it can name a path segment. */
export function encodeSessionIdForPath(sessionId: string): string {
	return encodeURIComponent(sessionId);
}

/** Directory paths for one session's forwarded-ask exchange. */
export interface ForwardingLocation {
	sessionId: string;
	sessionRootDir: string;
	requestsDir: string;
	responsesDir: string;
}

/** Resolve (without creating) one session's forwarding location. */
export function forwardingLocation(
	forwardingDir: string,
	sessionId: string,
): ForwardingLocation {
	const encoded = encodeSessionIdForPath(sessionId);
	const sessionRootDir = join(forwardingDir, SESSIONS_DIRECTORY_NAME, encoded);
	return {
		sessionId,
		sessionRootDir,
		requestsDir: join(sessionRootDir, REQUESTS_DIRECTORY_NAME),
		responsesDir: join(sessionRootDir, RESPONSES_DIRECTORY_NAME),
	};
}

function ensureDirectory(path: string): boolean {
	try {
		mkdirSync(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
		return true;
	} catch {
		return false;
	}
}

/** Create the request/response directories for `sessionId`, or `null` on failure. */
export function ensureForwardingLocation(
	forwardingDir: string,
	sessionId: string,
): ForwardingLocation | null {
	const location = forwardingLocation(forwardingDir, sessionId);
	const ready =
		ensureDirectory(location.sessionRootDir) &&
		ensureDirectory(location.requestsDir) &&
		ensureDirectory(location.responsesDir);
	return ready ? location : null;
}

/** The location for `sessionId` when its request directory already exists. */
export function getExistingForwardingLocation(
	forwardingDir: string,
	sessionId: string,
): ForwardingLocation | null {
	const location = forwardingLocation(forwardingDir, sessionId);
	return existsSync(location.requestsDir) ? location : null;
}

// ── JSON file IO ──────────────────────────────────────────────────────────────

/**
 * Write JSON atomically: a sibling temp file renamed into place, so a poller
 * never observes a half-written record.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
	ensureDirectory(dirname(path));
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(temp, JSON.stringify(value), {
		encoding: "utf-8",
		mode: OWNER_ONLY_FILE_MODE,
	});
	try {
		renameSync(temp, path);
	} catch (error) {
		safeDeleteFile(temp);
		throw error;
	}
}

/** Read and parse a JSON file, returning `null` on any failure. */
export function readJsonFile<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

/** Delete a file, ignoring "already gone". */
export function safeDeleteFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Missing is the desired end state.
	}
}

/** Names of the `.json` files in `dir`, or `[]` when it does not exist. */
export function listJsonFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

/** Remove a session's directories when no requests or responses remain. */
export function cleanupLocationIfEmpty(location: ForwardingLocation): void {
	removeIfEmpty(location.requestsDir);
	removeIfEmpty(location.responsesDir);
	removeIfEmpty(location.sessionRootDir);
}

function removeIfEmpty(path: string): void {
	try {
		if (existsSync(path) && readdirSync(path).length === 0) {
			rmdirSync(path);
		}
	} catch {
		// A concurrent writer won; leave the directory in place.
	}
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Serving heartbeat ─────────────────────────────────────────────────────────

/** How a serving session's heartbeat reads right now. */
export type HeartbeatState = "alive" | "absent" | "stale" | "dead_pid";

/** What a serving session publishes while it drains its forwarded-ask inbox. */
export interface ServingHeartbeat {
	sessionId: string;
	pid: number;
	updatedAt: number;
}

/** Runtime guard: a malformed record is treated as no heartbeat at all. */
function isServingHeartbeat(value: unknown): value is ServingHeartbeat {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ServingHeartbeat>;
	return (
		typeof record.sessionId === "string" &&
		typeof record.pid === "number" &&
		typeof record.updatedAt === "number"
	);
}

/** Directory holding serving heartbeats. */
export function servingHeartbeatDir(forwardingDir: string): string {
	return join(forwardingDir, SERVING_DIRECTORY_NAME);
}

/** Heartbeat record path for `sessionId`. */
export function servingHeartbeatPath(
	forwardingDir: string,
	sessionId: string,
): string {
	return join(
		servingHeartbeatDir(forwardingDir),
		`${encodeSessionIdForPath(sessionId)}.json`,
	);
}

/** How long an unrefreshed heartbeat is trusted before its writer is presumed gone. */
export const STALE_AFTER_MS = 5000;

function isRunningProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function classifyHeartbeat(
	record: ServingHeartbeat,
	now: number,
	isProcessAlive: (pid: number) => boolean,
): HeartbeatState {
	if (!isProcessAlive(record.pid)) return "dead_pid";
	if (now - record.updatedAt > STALE_AFTER_MS) return "stale";
	return "alive";
}

/**
 * How `sessionId`'s serving heartbeat reads right now, using process defaults.
 * Used by a forwarding child, which only reads.
 */
export function readServingHeartbeat(
	forwardingDir: string,
	sessionId: string,
): HeartbeatState {
	const record = readJsonFile<unknown>(
		servingHeartbeatPath(forwardingDir, sessionId),
	);
	return !isServingHeartbeat(record)
		? "absent"
		: classifyHeartbeat(record, Date.now(), isRunningProcess);
}

/**
 * Publishes this session's serving heartbeat to the filesystem so a subprocess
 * child can tell whether the session it forwards to is still polling.
 *
 * `markServing` is throttled and never throws: it runs from a poll timer, and a
 * filesystem failure must degrade to the pre-existing timeout rather than break
 * the loop.
 */
export class ServingHeartbeatStore {
	private readonly refreshMs: number;
	private published: { sessionId: string; at: number } | null = null;
	private swept = false;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly isProcessAlive: (pid: number) => boolean;

	constructor(
		private readonly forwardingDir: string,
		options: {
			refreshMs: number;
			now?: () => number;
			pid?: number;
			isProcessAlive?: (pid: number) => boolean;
		},
	) {
		this.now = options.now ?? Date.now;
		this.pid = options.pid ?? process.pid;
		this.isProcessAlive = options.isProcessAlive ?? isRunningProcess;
		this.refreshMs = options.refreshMs;
	}

	/** Publish or refresh `sessionId`'s heartbeat. Throttled per refresh interval. */
	markServing(sessionId: string): void {
		const at = this.now();
		if (
			this.published?.sessionId === sessionId &&
			at - this.published.at < this.refreshMs
		) {
			return;
		}
		if (!ensureDirectory(servingHeartbeatDir(this.forwardingDir))) return;
		this.sweepDeadRecordsOnce();
		try {
			writeJsonAtomic(servingHeartbeatPath(this.forwardingDir, sessionId), {
				sessionId,
				pid: this.pid,
				updatedAt: at,
			} satisfies ServingHeartbeat);
		} catch {
			return;
		}
		this.published = { sessionId, at };
	}

	/** Withdraw `sessionId`'s heartbeat. */
	clearServing(sessionId: string): void {
		if (this.published?.sessionId === sessionId) this.published = null;
		safeDeleteFile(servingHeartbeatPath(this.forwardingDir, sessionId));
	}

	/** How `sessionId`'s heartbeat reads right now. */
	read(sessionId: string): HeartbeatState {
		const record = readJsonFile<unknown>(
			servingHeartbeatPath(this.forwardingDir, sessionId),
		);
		return isServingHeartbeat(record) ? this.classify(record) : "absent";
	}

	/** Every session whose heartbeat reads as alive. */
	servingIds(): readonly string[] {
		const ids: string[] = [];
		const dir = servingHeartbeatDir(this.forwardingDir);
		for (const name of listJsonFiles(dir)) {
			const record = readJsonFile<unknown>(join(dir, name));
			if (isServingHeartbeat(record) && this.classify(record) === "alive")
				ids.push(record.sessionId);
		}
		return ids;
	}

	private classify(record: ServingHeartbeat): HeartbeatState {
		return classifyHeartbeat(record, this.now(), this.isProcessAlive);
	}

	/**
	 * Delete records of processes that are provably gone, once per session.
	 * Bounded to one directory read; a wrongly swept live owner republishes
	 * within a refresh interval, which is shorter than a child's grace window.
	 */
	private sweepDeadRecordsOnce(): void {
		if (this.swept) return;
		this.swept = true;
		const dir = servingHeartbeatDir(this.forwardingDir);
		for (const name of listJsonFiles(dir)) {
			const path = join(dir, name);
			const record = readJsonFile<unknown>(path);
			if (isServingHeartbeat(record) && !this.isProcessAlive(record.pid))
				safeDeleteFile(path);
		}
	}
}
