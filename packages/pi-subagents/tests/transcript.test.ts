import { describe, expect, it } from "bun:test";
import {
	buildBackgroundDetails,
	buildBackgroundResultText,
	buildForegroundResultText,
	buildGetResultText,
	buildNotificationDetails,
	buildNotificationText,
	notificationDeliveryOptions,
	escapeXml,
	formatTaskNotification,
	formatTokens,
	outputFileLine,
	RUN_IN_BACKGROUND_NOTE,
} from "../src/transcript.js";
import { SubagentRun } from "../src/run.js";

const WIRE_REGEX = /^Output file:\s*(\S+)$/m;

function makeRun(
	overrides: Partial<ConstructorParameters<typeof SubagentRun>[0]> = {},
) {
	return new SubagentRun({
		id: "9f2a",
		subagentType: "explore",
		displayName: "explore",
		description: "cmp background",
		outputFile: "/tmp/pi-example/subagent-9f2a.jsonl",
		startedAt: 1000,
		...overrides,
	});
}

describe("transcript wire shapes", () => {
	it("emits one unadorned, whitespace-free Output file line", () => {
		expect(outputFileLine("/tmp/pi-example/subagent-9f2a.jsonl")).toBe(
			"Output file: /tmp/pi-example/subagent-9f2a.jsonl",
		);
		expect(() => outputFileLine("/tmp/has space/x.jsonl")).toThrow();
	});

	it("background content matches tintinweb and carries the Output file line", () => {
		const run = makeRun();
		const text = buildBackgroundResultText(run);
		expect(WIRE_REGEX.exec(text)?.[1]).toBe(
			"/tmp/pi-example/subagent-9f2a.jsonl",
		);
		expect(text).toContain("Agent started in background.");
		expect(text).toContain("Agent ID: 9f2a");
		expect(text).toContain("Type: explore");
		expect(text).toContain("Description: cmp background");
		expect(text).toContain("Do not duplicate this agent's work.");
	});

	it("prepends the deprecation note when the caller passed run_in_background", () => {
		const text = buildBackgroundResultText(makeRun(), {
			note: RUN_IN_BACKGROUND_NOTE,
		});
		expect(text.startsWith(RUN_IN_BACKGROUND_NOTE)).toBe(true);
		expect(WIRE_REGEX.exec(text)?.[1]).toBe(
			"/tmp/pi-example/subagent-9f2a.jsonl",
		);
	});

	it("background details match tintinweb's immediate-launch shape", () => {
		expect(buildBackgroundDetails(makeRun())).toEqual({
			displayName: "explore",
			description: "cmp background",
			subagentType: "explore",
			toolUses: 0,
			tokens: "",
			durationMs: 0,
			status: "background",
			agentId: "9f2a",
		});
	});

	it("foreground content ends with the Output file line for Paseo", () => {
		const run = makeRun({ startedAt: 1000 });
		run.toolUses = 3;
		run.transition("completed", { summary: "pong" });
		const text = buildForegroundResultText(run);
		expect(text).toMatch(
			/^Agent completed in \d+\.\d+s \(3 tool uses\)\.\n\npong/,
		);
		expect(WIRE_REGEX.exec(text)?.[1]).toBe(
			"/tmp/pi-example/subagent-9f2a.jsonl",
		);
	});

	it("foreground content omits the line when there is no transcript path", () => {
		const run = makeRun({ startedAt: 1000, outputFile: undefined });
		run.transition("completed", { summary: "pong" });
		expect(buildForegroundResultText(run)).not.toContain("Output file:");
	});

	it("formats tokens the tintinweb way", () => {
		expect(formatTokens(0)).toBe("0 token");
		expect(formatTokens(102)).toBe("102 token");
		expect(formatTokens(3174)).toBe("3.2k token");
		expect(formatTokens(2_500_000)).toBe("2.5M token");
	});

	it("builds the <task-notification> XML and details", () => {
		const run = makeRun({ toolCallId: "call_1" });
		run.toolUses = 2;
		run.turnCount = 1;
		run.lifetimeUsage.input = 3000;
		run.lifetimeUsage.output = 174;
		run.transition("completed", { summary: "pong" });
		const xml = formatTaskNotification(run, 500);
		expect(xml).toContain("<task-id>9f2a</task-id>");
		expect(xml).toContain("<tool-use-id>call_1</tool-use-id>");
		expect(xml).toContain(
			"<output-file>/tmp/pi-example/subagent-9f2a.jsonl</output-file>",
		);
		expect(xml).toContain("<status>Done</status>");
		expect(xml).toContain(
			'<summary>Agent "cmp background" completed</summary>',
		);
		expect(xml).toContain("<result>pong</result>");
		expect(xml).toContain("<total_tokens>3174</total_tokens>");
		expect(xml).toContain("<tool_uses>2</tool_uses>");

		expect(buildNotificationDetails(run, 500)).toMatchObject({
			id: "9f2a",
			description: "cmp background",
			status: "completed",
			toolUses: 2,
			turnCount: 1,
			totalTokens: 3174,
			outputFile: "/tmp/pi-example/subagent-9f2a.jsonl",
			resultPreview: "pong",
		});
	});

	it("maps terminal steered status to completed in Paseo notification details", () => {
		const run = makeRun();
		run.transition("steered", { summary: "wrapped up at the turn limit" });

		expect(run.status).toBe("steered");
		expect(buildNotificationDetails(run, 500).status).toBe("completed");
		expect(buildNotificationText(run)).toContain(
			"wrapped up at the turn limit",
		);
		expect(buildGetResultText(run)).toContain("Status: steered");
	});

	it("notifies with a fenced block pointing at the result file", () => {
		const run = makeRun();
		run.transition("completed", { summary: "pong" });
		run.resultFile = "/tmp/run/result.md";
		const text = buildNotificationText(run);
		expect(text).toContain("completed");
		expect(text).toContain("Result: /tmp/run/result.md");
		expect(text).not.toContain("pong");
		expect(text).not.toContain("<");
		// Paseo merges it with the parent's preceding text; lead with a blank line.
		expect(text.startsWith("\n\n```\n")).toBe(true);
	});

	it("falls back to get_subagent_result when no result file was written", () => {
		const run = makeRun();
		run.transition("completed", { summary: "pong" });
		expect(buildNotificationText(run)).toContain("get_subagent_result");
	});

	it("suppresses only the wake-up turn for a claimed result", () => {
		const run = makeRun();
		expect(notificationDeliveryOptions(run)).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		run.claimResult();
		expect(notificationDeliveryOptions(run)).toEqual({
			deliverAs: "followUp",
			triggerTurn: false,
		});
	});

	it("escapes XML special characters", () => {
		expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
	});

	it("get_subagent_result text matches tintinweb", () => {
		const run = makeRun();
		run.transition("completed", { summary: "pong" });
		const text = buildGetResultText(run);
		expect(text).toContain("Agent: 9f2a");
		expect(text).toContain("Type: explore | Status: completed | Tool uses: 0");
		expect(text).toContain("Description: cmp background");
		expect(text.endsWith("pong")).toBe(true);
	});
});
