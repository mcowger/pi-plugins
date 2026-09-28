/**
 * Forwarded `ask` prompts between a subagent child and the session that owns
 * the UI.
 *
 * pi-control resolves an `ask` by prompting the user. A subagent child has no
 * UI, so `promptSelect` routes the prompt to the child's parent instead: the
 * child writes the ask into the parent's inbox and polls for the answer, and a
 * session with a UI polls its own inbox and shows the dialog. The human's
 * choice then travels back as the same `ctx.ui.select` result the child would
 * have received locally, so the surrounding policy logic is unchanged.
 *
 * The transport and liveness rules mirror `@gotgenes/pi-permission-system`.
 * In-process children are announced through the process-global registry; their
 * parent's liveness comes from the process-global serving registry.
 * Out-of-process children resolve their target from the environment and read a
 * filesystem heartbeat.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupLocationIfEmpty,
	defaultForwardingDir,
	ensureForwardingLocation,
	type ForwardingLocation,
	getExistingForwardingLocation,
	listJsonFiles,
	readJsonFile,
	readServingHeartbeat,
	safeDeleteFile,
	ServingHeartbeatStore,
	sleep,
	writeJsonAtomic,
} from "./forwarding-io.js";
import {
	type ForwardingTarget,
	getServingSessionRegistry,
	getSubagentSessionRegistry,
	isSubagentContext,
	readSessionId,
	resolveForwardingTarget,
	type SubagentDetectionContext,
} from "./subagent.js";

/** How often a forwarding child checks for its answer, and a parent drains its inbox. */
export const FORWARDING_POLL_INTERVAL_MS = 250;

/**
 * How long an in-process target may look unserved before the child abandons it
 * rather than waiting out the full timeout. A window, not a single tick, so a
 * request that lands while the parent is re-announcing is still picked up.
 */
export const FORWARDING_SERVING_GRACE_MS = 8 * FORWARDING_POLL_INTERVAL_MS;

/** How long a child waits for a human to answer a forwarded ask. */
export const FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;

/** How often a serving session rewrites its heartbeat — four poll ticks. */
export const FORWARDING_HEARTBEAT_REFRESH_MS = 4 * FORWARDING_POLL_INTERVAL_MS;

/** A child's ask, as written into its parent's inbox. */
export interface ForwardedAskRequest {
	id: string;
	createdAt: number;
	requesterSessionId: string;
	targetSessionId: string;
	title: string;
	choices: string[];
}

/** The parent's answer, as written back for the child to poll. */
export interface ForwardedAskResponse {
	/** Chosen label, or `null` when the human dismissed the prompt. */
	choice: string | null;
	responderSessionId: string;
	respondedAt: number;
}

/** Result of attempting to forward one ask. */
export interface ForwardAskResult {
	/** `true` when the parent answered; `false` when forwarding was unavailable. */
	forwarded: boolean;
	/** The chosen label on success; `null` when the human dismissed the prompt. */
	choice?: string | null;
	/** Why forwarding was unavailable, for logging/diagnostics. */
	reason?: string;
}

const FILENAME_SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

/** The current session id, or `null` when the host exposes none. */
function getSessionId(ctx: SubagentDetectionContext): string | null {
	return readSessionId(ctx);
}

/**
 * Resolve the session this context forwards its asks to, or `null` when it is
 * not a child, has no parent, or the only parent is itself.
 */
export function resolveTargetForContext(
	ctx: SubagentDetectionContext,
): ForwardingTarget | null {
	const registry = getSubagentSessionRegistry();
	if (!isSubagentContext(ctx, registry)) return null;
	const sessionId = readSessionId(ctx);
	return resolveForwardingTarget({
		isSubagent: true,
		currentSessionId: sessionId,
		sessionId,
		registry,
	});
}

/** Whether the target is draining its inbox, or `null` when it carries no signal. */
function isTargetServing(
	target: ForwardingTarget,
	forwardingDir: string,
): boolean | null {
	if (target.source === "registry") {
		return getServingSessionRegistry().isServing(target.sessionId);
	}
	return readServingHeartbeat(forwardingDir, target.sessionId) === "alive";
}

/**
 * Write an ask into the target's inbox and poll for the answer.
 *
 * Returns `forwarded: false` — never a synthetic denial — when the ask could
 * not be delivered or answered, so the caller decides between a local prompt
 * and a fail-closed denial.
 */
export async function forwardAsk(
	ctx: ExtensionContext,
	target: ForwardingTarget,
	ask: { title: string; choices: string[] },
	options: {
		forwardingDir?: string;
		timeoutMs?: number;
		pollIntervalMs?: number;
		servingGraceMs?: number;
	} = {},
): Promise<ForwardAskResult> {
	const forwardingDir = options.forwardingDir ?? defaultForwardingDir();
	const timeoutMs = options.timeoutMs ?? FORWARDING_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? FORWARDING_POLL_INTERVAL_MS;
	const servingGraceMs = options.servingGraceMs ?? FORWARDING_SERVING_GRACE_MS;

	const location = ensureForwardingLocation(forwardingDir, target.sessionId);
	if (!location) {
		return {
			forwarded: false,
			reason: `forwarding directories could not be prepared for session '${target.sessionId}'`,
		};
	}

	const request: ForwardedAskRequest = {
		id: randomUUID(),
		createdAt: Date.now(),
		requesterSessionId: getSessionId(ctx) ?? "unknown",
		targetSessionId: target.sessionId,
		title: ask.title,
		choices: ask.choices,
	};
	const requestPath = join(location.requestsDir, `${request.id}.json`);
	const responsePath = join(location.responsesDir, `${request.id}.json`);

	try {
		writeJsonAtomic(requestPath, request);
	} catch {
		return {
			forwarded: false,
			reason: "the forwarded ask could not be written",
		};
	}

	const deadline = Date.now() + timeoutMs;
	let unservedSince: number | null = null;

	while (Date.now() < deadline) {
		if (existsSync(responsePath)) {
			const response = readJsonFile<ForwardedAskResponse>(responsePath);
			discard(location, requestPath, responsePath);
			if (!response) {
				return {
					forwarded: false,
					reason: "the forwarded ask's response could not be read",
				};
			}
			// Accept only a label the child actually offered.
			const choice =
				typeof response.choice === "string" &&
				ask.choices.includes(response.choice)
					? response.choice
					: null;
			return { forwarded: true, choice };
		}

		const serving = isTargetServing(target, forwardingDir);
		if (serving === false) {
			unservedSince = unservedSince ?? Date.now();
			if (Date.now() - unservedSince >= servingGraceMs) {
				discard(location, requestPath);
				return {
					forwarded: false,
					reason: `session '${target.sessionId}' is not serving forwarded asks`,
				};
			}
		} else {
			unservedSince = null;
		}

		await sleep(pollIntervalMs);
	}

	discard(location, requestPath);
	return {
		forwarded: false,
		reason: `session '${target.sessionId}' did not answer within ${timeoutMs / 1000}s`,
	};
}

function discard(
	location: ForwardingLocation,
	requestPath: string,
	responsePath?: string,
): void {
	if (responsePath) safeDeleteFile(responsePath);
	safeDeleteFile(requestPath);
	cleanupLocationIfEmpty(location);
}

/**
 * Outcome of asking the user a question.
 *
 * `choice` is the answer (or `undefined` when the human dismissed the prompt);
 * `unavailableReason` is set instead when no human could be asked at all, so
 * the caller does not report a dismissal that never happened.
 */
export interface PromptSelectOutcome {
	choice?: string;
	unavailableReason?: string;
}

/**
 * Prompt the user, forwarding to the parent session when this context is a
 * subagent child.
 *
 * Falls back to a local dialog when the child has a UI of its own and
 * forwarding is unavailable; with neither, reports why no user could be asked.
 */
export async function promptSelect(
	ctx: ExtensionContext,
	title: string,
	choices: string[],
): Promise<PromptSelectOutcome> {
	const target = resolveTargetForContext(ctx);
	let unavailableReason: string | undefined;
	if (target) {
		const result = await forwardAsk(ctx, target, { title, choices });
		if (result.forwarded) return { choice: result.choice ?? undefined };
		unavailableReason = result.reason;
	}
	// `hasUI !== false` rather than `hasUI`: a host that omits the flag is
	// assumed to have a usable dialog, matching the pre-forwarding behavior.
	if (ctx.hasUI !== false) {
		return { choice: await ctx.ui.select(title, choices) };
	}
	return {
		unavailableReason:
			unavailableReason ?? "this session has no interactive UI",
	};
}

// ── Serving side ──────────────────────────────────────────────────────────────

/**
 * Drains one session's forwarded-ask inbox while it has a UI.
 *
 * `start` is called on every session event that may (re)activate forwarding and
 * is a no-op beyond updating the stored context once polling. `stop` is called
 * on session shutdown. Serving eligibility is `ctx.hasUI` alone: a node with a
 * UI has a human who can answer.
 */
export class ForwardingManager {
	private readonly forwardingDir: string;
	private readonly pollIntervalMs: number;
	private readonly heartbeats: ServingHeartbeatStore;
	private timer: NodeJS.Timeout | null = null;
	private ctx: ExtensionContext | null = null;
	private processing = false;
	private servingId: string | null = null;

	constructor(
		options: {
			forwardingDir?: string;
			pollIntervalMs?: number;
			heartbeatRefreshMs?: number;
		} = {},
	) {
		this.forwardingDir = options.forwardingDir ?? defaultForwardingDir();
		this.pollIntervalMs = options.pollIntervalMs ?? FORWARDING_POLL_INTERVAL_MS;
		this.heartbeats = new ServingHeartbeatStore(this.forwardingDir, {
			refreshMs: options.heartbeatRefreshMs ?? FORWARDING_HEARTBEAT_REFRESH_MS,
		});
	}

	/** Start or re-arm polling for the given context. */
	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			this.stop();
			return;
		}
		this.ctx = ctx;
		this.announceServing(getSessionId(ctx));
		if (this.timer) return;
		this.timer = setInterval(() => {
			// Refresh ahead of the processing guard: a session deliberating at a
			// forwarded dialog holds `processInbox` open, and it is serving
			// throughout.
			this.refreshServing();
			if (!this.ctx || this.processing) return;
			this.processing = true;
			void this.processInbox(this.ctx)
				.catch(() => {
					// A drain failure must not stop the poll loop or surface as an
					// unhandled rejection; the next tick retries.
				})
				.finally(() => {
					this.processing = false;
				});
		}, this.pollIntervalMs);
	}

	/** Stop polling and withdraw the serving announcement. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.withdrawServing();
		this.ctx = null;
		this.processing = false;
	}

	/** Answer every request waiting in this session's inbox. */
	async processInbox(ctx: ExtensionContext): Promise<void> {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;
		const location = getExistingForwardingLocation(
			this.forwardingDir,
			sessionId,
		);
		if (!location) return;

		for (const fileName of listJsonFiles(location.requestsDir)) {
			const requestPath = join(location.requestsDir, fileName);
			const request = readJsonFile<ForwardedAskRequest>(requestPath);
			if (
				!isValidRequest(request) ||
				request.targetSessionId !== sessionId ||
				// A request whose child has already given up (and may have crashed
				// without deleting it) must not be prompted for long after.
				Date.now() - request.createdAt > FORWARDING_TIMEOUT_MS
			) {
				safeDeleteFile(requestPath);
				continue;
			}
			await this.answer(ctx, location, requestPath, sessionId, request);
		}

		cleanupLocationIfEmpty(location);
	}

	private async answer(
		ctx: ExtensionContext,
		location: ForwardingLocation,
		requestPath: string,
		sessionId: string,
		request: ForwardedAskRequest,
	): Promise<void> {
		let choice: string | null = null;
		try {
			choice = (await ctx.ui.select(request.title, request.choices)) ?? null;
		} catch {
			choice = null;
		}
		const responsePath = join(location.responsesDir, `${request.id}.json`);
		try {
			writeJsonAtomic(responsePath, {
				choice,
				responderSessionId: sessionId,
				respondedAt: Date.now(),
			} satisfies ForwardedAskResponse);
			safeDeleteFile(requestPath);
		} catch {
			// Keep the request so the next tick can retry the response.
		}
	}

	private announceServing(sessionId: string | null): void {
		if (!sessionId || sessionId === this.servingId) return;
		this.withdrawServing();
		this.servingId = sessionId;
		this.markServing(sessionId);
	}

	private refreshServing(): void {
		if (!this.servingId || !this.ctx) return;
		const liveSessionId = getSessionId(this.ctx);
		if (liveSessionId && liveSessionId !== this.servingId) {
			this.announceServing(liveSessionId);
			return;
		}
		this.markServing(this.servingId);
	}

	private markServing(sessionId: string): void {
		getServingSessionRegistry().markServing(sessionId);
		this.heartbeats.markServing(sessionId);
	}

	private withdrawServing(): void {
		const sessionId = this.servingId;
		if (!sessionId) return;
		this.servingId = null;
		getServingSessionRegistry().clearServing(sessionId);
		this.heartbeats.clearServing(sessionId);
	}
}

/** Validate a request read from disk before trusting it. */
function isValidRequest(
	request: ForwardedAskRequest | null,
): request is ForwardedAskRequest {
	return Boolean(
		request &&
			typeof request.id === "string" &&
			FILENAME_SAFE_REQUEST_ID.test(request.id) &&
			typeof request.createdAt === "number" &&
			typeof request.targetSessionId === "string" &&
			typeof request.title === "string" &&
			Array.isArray(request.choices) &&
			request.choices.length > 0 &&
			request.choices.every((choice) => typeof choice === "string"),
	);
}
