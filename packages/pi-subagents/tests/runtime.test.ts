import { describe, expect, it } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL,
	type PlexuspiSubagentBridgeRecord,
} from "../src/bridge.js";
import { SubagentRun } from "../src/run.js";
import {
	armRunTimeout,
	relayChildBridgeRecords,
	resolveTerminalStatus,
} from "../src/runtime.js";

describe("armRunTimeout", () => {
	it("aborts the run with a timeout reason", async () => {
		const r = new SubagentRun({
			id: "t",
			subagentType: "explore",
			displayName: "explore",
		});
		const disarm = armRunTimeout(r, 0.001); // ~60ms
		await new Promise((resolve) => setTimeout(resolve, 120));
		disarm();
		expect(r.terminationIntent).toBe("aborted");
		expect(r.terminationReason).toContain("timeout");
	});

	it("does nothing when undefined or zero", () => {
		const r = new SubagentRun({
			id: "t2",
			subagentType: "explore",
			displayName: "explore",
		});
		armRunTimeout(r, undefined)();
		armRunTimeout(r, 0)();
		expect(r.terminationIntent).toBeUndefined();
		expect(r.abortController.signal.aborted).toBe(false);
	});
});

describe("resolveTerminalStatus", () => {
	it("marks a provider error as error", () => {
		expect(
			resolveTerminalStatus(
				{
					providerError: "faulty provider error",
					hardAborted: false,
					softSteered: false,
				},
				1,
			),
		).toEqual({
			status: "error",
			error: "faulty provider error",
		});
	});

	it("marks a hard turn-limit abort as aborted", () => {
		expect(
			resolveTerminalStatus({ hardAborted: true, softSteered: true }, 3),
		).toEqual({
			status: "aborted",
			error: "max_turns 3 reached",
		});
	});

	it("marks a soft turn-limit wrap-up as steered", () => {
		expect(
			resolveTerminalStatus({ hardAborted: false, softSteered: true }, 3),
		).toEqual({ status: "steered" });
	});

	it("prefers a provider error over a turn-limit abort", () => {
		expect(
			resolveTerminalStatus(
				{ providerError: "boom", hardAborted: true, softSteered: true },
				3,
			).status,
		).toBe("error");
	});

	it("defaults to completed", () => {
		expect(
			resolveTerminalStatus(
				{ hardAborted: false, softSteered: false },
				undefined,
			),
		).toEqual({ status: "completed" });
	});
});

describe("relayChildBridgeRecords", () => {
	it("forwards a grandchild record from the child-local bus and stops on cleanup", () => {
		const bus = createEventBus();
		const forwarded: PlexuspiSubagentBridgeRecord[] = [];
		const stop = relayChildBridgeRecords(bus, (record) =>
			forwarded.push(record),
		);
		const grandchild: PlexuspiSubagentBridgeRecord = {
			version: 1,
			runId: "grandchild",
			sequence: 1,
			type: "created",
			parentRunId: "child",
		};

		bus.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, grandchild);
		expect(forwarded).toEqual([grandchild]);
		// Identities survive unchanged; the relay never rewrites the record.
		expect(forwarded[0]?.parentRunId).toBe("child");

		stop();
		bus.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, {
			...grandchild,
			sequence: 2,
		});
		expect(forwarded).toHaveLength(1);
	});

	it("drops values that are not version-1 bridge records", () => {
		const bus = createEventBus();
		const forwarded: unknown[] = [];
		const stop = relayChildBridgeRecords(bus, (record) =>
			forwarded.push(record),
		);

		bus.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, { hello: "world" });
		bus.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, {
			version: 2,
			runId: "x",
			sequence: 1,
		});
		bus.emit(PLEXUSPI_SUBAGENT_BRIDGE_CHANNEL, null);
		expect(forwarded).toEqual([]);
		stop();
	});
});
