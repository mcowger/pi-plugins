import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EVENT_ENTRY_TYPE, EVENT_SCHEMA_VERSION } from "./constants.ts";
import { boundJson } from "./truncate.ts";
import type { SuperAgentsConfig } from "./types.ts";

export interface EventContext {
	agentId: string;
	name: string;
	slug: string;
	parentToolCallId: string;
	background: boolean;
}

/**
 * Drops noisy child events that should never be forwarded to the parent:
 * streaming `message_update` deltas (`message_end` already carries the full
 * message) and `entry_appended` (the child's own in-memory session entries).
 * Everything else passes through unchanged.
 */
export function shapeSessionEvent(event: AgentSessionEvent): unknown | undefined {
	if (event.type === "message_update" || event.type === "entry_appended") {
		return undefined;
	}
	return event;
}

export class EventEmitter {
	#append: (customType: string, data: unknown) => void;
	#config: SuperAgentsConfig;
	#seq = new Map<string, number>();

	constructor(opts: { append: (customType: string, data: unknown) => void; config: SuperAgentsConfig }) {
		this.#append = opts.append;
		this.#config = opts.config;
	}

	lifecycle(ctx: EventContext, phase: "queued" | "started" | "finished", data?: Record<string, unknown>): void {
		if (!this.#config.events.enabled) return;

		this.#emit({
			...this.#envelope(ctx),
			kind: "lifecycle",
			phase,
			...(data !== undefined ? { data } : {}),
		});
	}

	session(ctx: EventContext, event: AgentSessionEvent): void {
		if (!this.#config.events.enabled) return;

		const shaped = shapeSessionEvent(event);
		if (shaped === undefined) return;

		this.#emit({
			...this.#envelope(ctx),
			kind: "session",
			event: shaped,
		});
	}

	#envelope(ctx: EventContext): Record<string, unknown> {
		return {
			v: EVENT_SCHEMA_VERSION,
			seq: this.#nextSeq(ctx.agentId),
			ts: Date.now(),
			agentId: ctx.agentId,
			name: ctx.name,
			slug: ctx.slug,
			parentToolCallId: ctx.parentToolCallId,
			background: ctx.background,
		};
	}

	#nextSeq(agentId: string): number {
		const next = this.#seq.get(agentId) ?? 0;
		this.#seq.set(agentId, next + 1);
		return next;
	}

	#emit(payload: Record<string, unknown>): void {
		const bounded = boundJson(payload, this.#config.maxEventBytes);
		const value =
			bounded.value !== null && typeof bounded.value === "object"
				? { ...(bounded.value as Record<string, unknown>), truncated: bounded.truncated }
				: bounded.value;

		try {
			this.#append(EVENT_ENTRY_TYPE, value);
		} catch {
			// telemetry must never break a run
		}
	}
}
