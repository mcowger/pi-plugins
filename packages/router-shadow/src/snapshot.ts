/**
 * Sync turn snapshot (REQUIREMENTS R4.2, R4.3).
 *
 * Everything the background run needs is copied inside the
 * `before_agent_start` handler: prompt, images flag, branch entries, model,
 * thinking level, session file/id/header and cwd. Structural types keep this
 * decoupled from the SDK and unit-testable.
 */

import type { EntryLike } from "./context/entries.js";

export interface SnapshotModel {
	id: string;
	provider: string;
}

export interface TurnSnapshot {
	prompt: string;
	hasImages: boolean;
	/** Shallow copy of the branch array (entries themselves are read-only). */
	branch: EntryLike[];
	/** Entry ids present at snapshot time (pre-existing vs new entry). */
	knownIds: string[];
	model: SnapshotModel | undefined;
	thinking: string | undefined;
	sessionFile: string | null;
	sessionId: string;
	parentSession: string | null;
	cwd: string;
	/** Last observed `input` event source, if any. */
	inputSource: string | undefined;
	/** Handler wall-clock time. */
	at: number;
}

export interface SnapshotEvent {
	prompt?: unknown;
	images?: unknown;
}

export interface SnapshotSessionManager {
	getBranch(): EntryLike[];
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getHeader(): { parentSession?: string } | null;
	getCwd(): string;
}

export interface SnapshotContext {
	cwd: string;
	model?: { id?: unknown; provider?: unknown };
	thinkingLevel?: string;
	sessionManager: SnapshotSessionManager;
}

/** Copy every background input. Must stay synchronous and allocation-light. */
export function captureSnapshot(
	event: SnapshotEvent,
	ctx: SnapshotContext,
	inputSource: string | undefined,
): TurnSnapshot {
	const prompt = typeof event.prompt === "string" ? event.prompt : "";
	const images = event.images;
	const model = ctx.model;
	const header = safeHeader(ctx.sessionManager);
	const branch = ctx.sessionManager.getBranch().slice();
	return {
		prompt,
		hasImages: Array.isArray(images) ? images.length > 0 : !!images,
		branch,
		knownIds: branch
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string"),
		model:
			model && typeof model.id === "string"
				? {
						id: model.id,
						provider:
							typeof model.provider === "string" ? model.provider : "unknown",
					}
				: undefined,
		thinking: ctx.thinkingLevel,
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
		sessionId: ctx.sessionManager.getSessionId(),
		parentSession: header?.parentSession ?? null,
		cwd: ctx.sessionManager.getCwd() ?? ctx.cwd,
		inputSource,
		at: Date.now(),
	};
}

function safeHeader(
	sessionManager: SnapshotSessionManager,
): { parentSession?: string } | null {
	try {
		return sessionManager.getHeader();
	} catch {
		return null;
	}
}
