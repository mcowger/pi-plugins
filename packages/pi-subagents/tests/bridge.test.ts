import { describe, expect, it } from "bun:test";
import {
	bridgeOutcomeFor,
	createRunBridge,
	MAX_BRIDGE_RECORD_BYTES,
	projectActivity,
	type SuperpiSubagentBridgeRecord,
	toBridgeValue,
} from "../src/bridge.js";

function capture() {
	const records: SuperpiSubagentBridgeRecord[] = [];
	return {
		records,
		sink: (record: SuperpiSubagentBridgeRecord) => records.push(record),
	};
}

const IDS = {
	runId: "0123456789ab",
	parentRunId: "parent-run",
	parentSessionId: "parent-session",
	childSessionId: "child-session",
	toolCallId: "tool-call-1",
	title: "recon",
	transcriptPath: "/tmp/subagents/0123456789ab/session.jsonl",
};

describe("createRunBridge", () => {
	it("leaves room for notification escaping inside an eight MiB RPC frame", () => {
		const { records, sink } = capture();
		const bridge = createRunBridge(sink, IDS);
		bridge.created();
		bridge.activity({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "\\".repeat(MAX_BRIDGE_RECORD_BYTES / 2 - 1024),
					},
				],
			},
		});
		const message = `superpi:child:v1:${JSON.stringify({ version: 1, sessionKey: "root", record: records[1] })}`;
		const frame = JSON.stringify({
			type: "extension_ui_request",
			method: "notify",
			message,
		});
		expect(Buffer.byteLength(frame)).toBeLessThan(8 * 1024 * 1024);
	});
	it("orders created, activity, and terminal with a monotonic sequence", () => {
		const { records, sink } = capture();
		const bridge = createRunBridge(sink, IDS);

		bridge.created();
		bridge.activity({ type: "message_start", message: { role: "user" } });
		bridge.activity({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			result: { ok: true },
		});
		bridge.terminal({ outcome: "completed", result: "done" });

		expect(records.map((r) => r.type)).toEqual([
			"created",
			"activity",
			"activity",
			"terminal",
		]);
		expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
		for (const record of records) {
			expect(record.version).toBe(1);
			expect(record.runId).toBe("0123456789ab");
			expect(record.childSessionId).toBe("child-session");
			expect(record.parentSessionId).toBe("parent-session");
			expect(record.toolCallId).toBe("tool-call-1");
			expect(record.parentRunId).toBe("parent-run");
		}
		expect(records[3].outcome).toBe("completed");
		expect(records[3].result).toBe("done");
	});

	it("keeps a fast child ordered and terminal sticky", () => {
		const { records, sink } = capture();
		const bridge = createRunBridge(sink, IDS);

		// A child that finishes almost immediately still reports created before
		// its single activity and terminal record.
		bridge.created({ timestamp: 100 });
		bridge.activity({ type: "message_end", message: { role: "assistant" } });
		bridge.terminal({ outcome: "completed", timestamp: 200 });

		expect(records.map((r) => r.type)).toEqual([
			"created",
			"activity",
			"terminal",
		]);
		expect(records[2].timestamp).toBe(200);

		// Late collection must never reopen the run.
		expect(
			bridge.activity({ type: "message_end", message: { role: "assistant" } }),
		).toBe(false);
		bridge.created();
		bridge.terminal({ outcome: "failed", reason: "late" });
		expect(bridge.terminalEmitted).toBe(true);
		expect(records).toHaveLength(3);
	});

	it("bridges streaming message and tool updates", () => {
		expect(projectActivity({ type: "message_start", message: {} })?.kind).toBe(
			"message_start",
		);
		expect(
			projectActivity({ type: "tool_execution_start", toolName: "bash" })?.kind,
		).toBe("tool_execution_start");
		expect(projectActivity({ type: "turn_start" })?.kind).toBe("turn_start");
		expect(projectActivity({ type: "turn_end", toolResults: [] })?.kind).toBe(
			"turn_end",
		);

		const messageUpdate = projectActivity({
			type: "message_update",
			usage: { input: 3, output: 1 },
			message: { role: "assistant", timestamp: 5 },
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hel",
				partial: {
					role: "assistant",
					timestamp: 5,
					content: [{ type: "text", text: "Hel" }],
				},
			},
		});
		expect(messageUpdate?.kind).toBe("message_update");
		expect(messageUpdate?.usage).toEqual({ input: 3, output: 1 });
		expect(messageUpdate?.assistantMessageEvent).toMatchObject({
			type: "text_delta",
			delta: "Hel",
			partial: { content: [{ type: "text", text: "Hel" }] },
		});

		const toolUpdate = projectActivity({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { output: "half" },
		});
		expect(toolUpdate?.kind).toBe("tool_execution_update");
		expect(toolUpdate?.toolCallId).toBe("t1");
		expect(toolUpdate?.toolName).toBe("bash");
		expect(toolUpdate?.args).toEqual({ command: "ls" });
		expect(toolUpdate?.partialResult).toEqual({ output: "half" });

		expect(projectActivity({ type: "agent_end" })).toBeUndefined();
		expect(projectActivity(undefined)).toBeUndefined();
	});

	it("does not emit activity when no bridge is attached", () => {
		const bridge = createRunBridge(() => {}, IDS);
		expect(
			bridge.activity({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			}),
		).toBe(true);
	});

	it("preserves a finalized string in full and marks an oversized record omitted", () => {
		const { records, sink } = capture();
		const bridge = createRunBridge(sink, IDS);
		bridge.created();
		const text = "x".repeat(20_000);
		bridge.activity({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		const finalized = records[1].record as {
			message: { content: Array<{ text: string }> };
		};
		expect(finalized.message.content[0].text).toBe(text);
		expect(finalized.message.content[0].text.includes("[truncated]")).toBe(
			false,
		);

		const huge = "y".repeat(MAX_BRIDGE_RECORD_BYTES + 1024);
		bridge.activity({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: huge }] },
		});
		const omitted = records[2];
		expect(omitted.omitted).toBe(true);
		expect(omitted.omittedBytes).toBeGreaterThan(MAX_BRIDGE_RECORD_BYTES);
		expect(omitted.record).toBeUndefined();
		// Identity and the native transcript reference survive for recovery.
		expect(omitted.runId).toBe(IDS.runId);
		expect(omitted.transcriptPath).toBe(IDS.transcriptPath);
		expect(omitted.cwd).toBeUndefined();
	});
});

describe("bridgeOutcomeFor", () => {
	it("maps internal statuses to the host vocabulary", () => {
		expect(bridgeOutcomeFor("completed")).toBe("completed");
		expect(bridgeOutcomeFor("steered")).toBe("steered");
		expect(bridgeOutcomeFor("stopped")).toBe("canceled");
		expect(bridgeOutcomeFor("aborted")).toBe("canceled");
		expect(bridgeOutcomeFor("error")).toBe("failed");
	});
});

describe("toBridgeValue", () => {
	it("produces a serializable bounded projection", () => {
		const circular: Record<string, unknown> = { name: "root" };
		circular.self = circular;
		const projected = toBridgeValue({
			circular,
			big: 10n,
			tool: "read",
			noop: () => {},
			long: "x".repeat(20_000),
		}) as Record<string, unknown>;

		expect(projected.big).toBe("10");
		expect(projected.tool).toBe("read");
		expect(projected.noop).toBeUndefined();
		// Strings are preserved in full; the per-record cap bounds whole records.
		expect(projected.long).toBe("x".repeat(20_000));
		const projectedCircular = projected.circular as Record<string, unknown>;
		expect(projectedCircular.self).toBe("[circular]");
		// The projection itself is JSON-serializable.
		expect(() => JSON.stringify(projected)).not.toThrow();
	});
});
