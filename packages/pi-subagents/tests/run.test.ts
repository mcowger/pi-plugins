import { describe, expect, it } from "bun:test";
import { RunTerminalError, SubagentRun } from "../src/run.js";

function run(id = "a") {
	return new SubagentRun({
		id,
		subagentType: "explore",
		displayName: "explore",
	});
}

describe("SubagentRun", () => {
	it("freezes terminal states", () => {
		const r = run();
		r.transition("completed");
		expect(r.terminal).toBe(true);
		expect(() => r.transition("running")).toThrow(RunTerminalError);
		expect(r.status).toBe("completed");
	});

	it("resolves settled exactly once on terminal", async () => {
		const r = run();
		expect(r.terminal).toBe(false);
		r.transition("error", { error: "boom" });
		await r.settled;
		expect(r.error).toBe("boom");
		expect(r.endedAt).toBeGreaterThan(0);
	});

	it("tracks lifetime token totals", () => {
		const r = run();
		r.lifetimeUsage.input = 100;
		r.lifetimeUsage.output = 20;
		r.lifetimeUsage.cacheWrite = 5;
		expect(r.totalTokens).toBe(125);
	});
});
