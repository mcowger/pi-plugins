import { describe, expect, it } from "bun:test";
import { SubagentRun } from "../src/run.js";
import { armRunTimeout, resolveTerminalStatus } from "../src/runtime.js";

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
