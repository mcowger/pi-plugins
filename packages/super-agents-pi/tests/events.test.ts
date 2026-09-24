import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { type EventContext, EventEmitter, shapeSessionEvent } from "../src/events.ts";
import type { SuperAgentsConfig } from "../src/types.ts";

function config(overrides: Partial<SuperAgentsConfig> = {}): SuperAgentsConfig {
	return { ...DEFAULT_CONFIG, events: { ...DEFAULT_CONFIG.events }, ...overrides };
}

const ctx: EventContext = {
	agentId: "agent-1",
	name: "scout",
	slug: "scout",
	parentToolCallId: "tc-1",
	background: false,
};

describe("shapeSessionEvent", () => {
	it("drops message_update events", () => {
		expect(shapeSessionEvent({ type: "message_update" } as never)).toBeUndefined();
	});

	it("drops entry_appended events", () => {
		expect(shapeSessionEvent({ type: "entry_appended" } as never)).toBeUndefined();
	});

	it("passes everything else through as-is", () => {
		const event = { type: "turn_start" } as never;
		expect(shapeSessionEvent(event)).toBe(event);
	});
});

describe("EventEmitter.lifecycle", () => {
	it("appends a lifecycle entry with the expected envelope", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.lifecycle(ctx, "queued");

		expect(append).toHaveBeenCalledTimes(1);
		const [customType, data] = append.mock.calls[0] as [string, Record<string, unknown>];
		expect(customType).toBe("super-agents-event");
		expect(data).toMatchObject({
			v: 1,
			seq: 0,
			agentId: "agent-1",
			name: "scout",
			slug: "scout",
			parentToolCallId: "tc-1",
			background: false,
			kind: "lifecycle",
			phase: "queued",
		});
		expect(typeof data.ts).toBe("number");
	});

	it("includes data when provided", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.lifecycle(ctx, "started", { model: "anthropic/claude", thinking: "low" });

		const [, data] = append.mock.calls[0] as [string, Record<string, unknown>];
		expect(data.data).toEqual({ model: "anthropic/claude", thinking: "low" });
	});

	it("does nothing when events are disabled", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config({ events: { enabled: false } }) });

		emitter.lifecycle(ctx, "queued");
		emitter.lifecycle(ctx, "started");

		expect(append).not.toHaveBeenCalled();
	});
});

describe("EventEmitter.session", () => {
	it("appends a session entry for a passthrough event", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.session(ctx, { type: "turn_start" } as never);

		expect(append).toHaveBeenCalledTimes(1);
		const [, data] = append.mock.calls[0] as [string, Record<string, unknown>];
		expect(data.kind).toBe("session");
		expect(data.event).toEqual({ type: "turn_start" });
	});

	it("does not append anything for a dropped event (message_update)", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.session(ctx, { type: "message_update" } as never);

		expect(append).not.toHaveBeenCalled();
	});

	it("does not append anything for a dropped event (entry_appended)", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.session(ctx, { type: "entry_appended" } as never);

		expect(append).not.toHaveBeenCalled();
	});

	it("does not append and does not consume a seq slot for a dropped event", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });

		emitter.session(ctx, { type: "message_update" } as never);
		emitter.lifecycle(ctx, "queued");

		expect(append).toHaveBeenCalledTimes(1);
		const [, data] = append.mock.calls[0] as [string, Record<string, unknown>];
		expect(data.seq).toBe(0); // unaffected by the dropped session event
	});

	it("does nothing when events are disabled", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config({ events: { enabled: false } }) });

		emitter.session(ctx, { type: "turn_start" } as never);

		expect(append).not.toHaveBeenCalled();
	});

	it("bounds an oversized event and marks it truncated within maxEventBytes", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const cfg = config({ maxEventBytes: 1024 });
		const emitter = new EventEmitter({ append, config: cfg });

		const bigEvent = {
			type: "tool_execution_end",
			toolCallId: "x",
			toolName: "bash",
			result: "y".repeat(100_000),
		} as never;

		emitter.session(ctx, bigEvent);

		expect(append).toHaveBeenCalledTimes(1);
		const [, data] = append.mock.calls[0] as [string, Record<string, unknown>];
		expect(data.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(data), "utf-8")).toBeLessThanOrEqual(cfg.maxEventBytes);
	});
});

describe("EventEmitter seq", () => {
	it("increments per agentId, independently across agents", () => {
		const append = mock((_customType: string, _data: unknown) => {});
		const emitter = new EventEmitter({ append, config: config() });
		const ctxA: EventContext = { ...ctx, agentId: "agent-a" };
		const ctxB: EventContext = { ...ctx, agentId: "agent-b" };

		emitter.lifecycle(ctxA, "queued");
		emitter.lifecycle(ctxA, "started");
		emitter.lifecycle(ctxB, "queued");
		emitter.lifecycle(ctxA, "finished");
		emitter.lifecycle(ctxB, "started");

		const seqFor = (agentId: string) =>
			append.mock.calls
				.filter(([, data]) => (data as Record<string, unknown>).agentId === agentId)
				.map(([, data]) => (data as Record<string, unknown>).seq);

		expect(seqFor("agent-a")).toEqual([0, 1, 2]);
		expect(seqFor("agent-b")).toEqual([0, 1]);
	});
});

describe("EventEmitter append error isolation", () => {
	it("swallows errors thrown by append", () => {
		const append = mock((_customType: string, _data: unknown) => {
			throw new Error("boom");
		});
		const emitter = new EventEmitter({ append, config: config() });

		expect(() => emitter.lifecycle(ctx, "queued")).not.toThrow();
	});
});
