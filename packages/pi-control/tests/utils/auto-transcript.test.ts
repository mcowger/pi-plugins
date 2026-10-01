import { describe, expect, test } from "bun:test";
import { formatAutoVerdictNotice } from "../../src/utils/auto-transcript.js";

describe("formatAutoVerdictNotice", () => {
	test("puts verdict, command, and each explanation clause on its own line", () => {
		expect(
			formatAutoVerdictNotice({
				tool: "bash",
				command: "kill 1",
				verdict: "allow",
				explanation:
					"backstop score 33.95 < 40; other signals: destructive=no; targets: /repo (within)",
				targets: ["/repo"],
			}),
		).toBe(
			[
				"pi-controls auto: ALLOW",
				"$ kill 1",
				"• backstop score 33.95 < 40",
				"• other signals: destructive=no",
				"• targets: /repo (within)",
			].join("\n"),
		);
	});

	test("names the tool when there is no bash command", () => {
		expect(
			formatAutoVerdictNotice({
				tool: "write",
				command: null,
				verdict: "deny",
				explanation: "rule: destructive",
				targets: [],
			}),
		).toBe("pi-controls auto: DENY\ntool: write\n• rule: destructive");
	});
});
