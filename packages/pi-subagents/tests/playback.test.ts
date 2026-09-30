/**
 * Playback tests over real RPC traces captured from Pi.
 *
 * `fixtures/tintinweb-rpc.jsonl` is a recorded run of `@tintinweb/pi-subagents`
 * (the contract oracle). `fixtures/mine-rpc.jsonl` is a recorded run of this
 * extension. Each fixture is replayed through the current builders, so any drift
 * in result text, details, notifications, or lifecycle payloads fails here.
 *
 * The traces were captured with the real binary in RPC mode against the same
 * isolated agent dirs; see the comparison harness referenced in the commit.
 */

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRun } from "../src/run.js";
import {
	buildAgentDetails,
	buildBackgroundDetails,
	buildBackgroundResultText,
	buildCreatedEvent,
	buildEventData,
	buildForegroundResultText,
	buildGetResultText,
	buildNotificationDetails,
	buildStartedEvent,
	formatTaskNotification,
} from "../src/transcript.js";

const T0 = 1_700_000_000_000;

afterEach(() => setSystemTime());

type Rec = Record<string, any>;

function load(label: string): Rec[] {
	const path = join(import.meta.dir, "fixtures", `${label}-rpc.jsonl`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function toolEnds(records: Rec[], toolName: string): Rec[] {
	return records.filter(
		(record) =>
			record.type === "tool_execution_end" && record.toolName === toolName,
	);
}

function must<T>(value: T | undefined, label: string): T {
	if (value === undefined)
		throw new Error(`missing replay fixture record: ${label}`);
	return value;
}

function notification(records: Rec[]): Rec {
	return must(
		records.find(
			(record) =>
				record.type === "message_end" &&
				record.message?.role === "custom" &&
				record.message.customType === "subagent-notification",
		),
		"subagent-notification",
	);
}

function probe(records: Rec[], channel: string): Rec | undefined {
	const prefix = `PROBE ${channel} `;
	for (const record of records) {
		if (record.type !== "extension_ui_request" || record.method !== "notify")
			continue;
		const message = String(record.message ?? "");
		if (message.startsWith(prefix))
			return JSON.parse(message.slice(prefix.length));
	}
	return undefined;
}

function parseTag(xml: string, tag: string): string | undefined {
	const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return match?.[1];
}

function parseTokens(text: string): {
	input: number;
	output: number;
	total: number;
} {
	const match = text.match(/^([\d.]+)([kM])? token$/);
	if (!match) return { input: 0, output: 0, total: 0 };
	const value = Number.parseFloat(match[1]);
	const scale = match[2] === "k" ? 1_000 : match[2] === "M" ? 1_000_000 : 1;
	const total = Math.round(value * scale);
	return { input: total, output: 0, total };
}

/**
 * The background result's guidance line deliberately differs from tintinweb's:
 * every child is background, so we tell the model how to block for the result.
 * Mask it so the rest of the recorded content is still compared byte for byte.
 */
function normalizeGuidance(text: string): string {
	return text.replace(
		/Use get_subagent_result[^\n]*/g,
		"Use get_subagent_result …",
	);
}

function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) out[key] = stripUndefined(entry);
		}
		return out;
	}
	return value;
}

function replay(label: string): void {
	const records = load(label);
	const notif = notification(records);
	const notifContent: string = notif.message.content;
	const notifDetails: Rec = notif.message.details;

	const bgEnd = must(
		toolEnds(records, "Agent").find(
			(record) => record.result.details?.status === "background",
		),
		`${label}: background spawn`,
	);
	const fgEnd = must(
		toolEnds(records, "Agent").find(
			(record) =>
				!record.isError && record.result.details?.status === "completed",
		),
		`${label}: foreground spawn`,
	);
	const getEnd = must(
		toolEnds(records, "get_subagent_result")[0],
		`${label}: get_subagent_result`,
	);

	const bg: Rec = bgEnd.result.details;
	const outputFile = parseTag(notifContent, "output-file") as string;
	const toolCallId = parseTag(notifContent, "tool-use-id") as string;
	const completedEvent = must(
		probe(records, "subagents:completed"),
		`${label}: subagents:completed`,
	);
	const usage = completedEvent.tokens as {
		input: number;
		output: number;
		total: number;
	};

	// --- Background run ---
	const bgRun = new SubagentRun({
		id: bg.agentId,
		subagentType: bg.subagentType,
		displayName: bg.displayName,
		description: bg.description,
		outputFile,
		toolCallId,
		maxTurns: notifDetails.maxTurns,
		tags: bg.tags,
		startedAt: T0,
		initialStatus: "background",
	});
	bgRun.toolUses = notifDetails.toolUses;
	bgRun.turnCount = notifDetails.turnCount;
	bgRun.lifetimeUsage.input = usage.input;
	bgRun.lifetimeUsage.output = usage.output;
	bgRun.resultText = parseTag(notifContent, "result");
	bgRun.contextPercent = Number(parseTag(notifContent, "context_percent"));

	expect(
		normalizeGuidance(buildBackgroundResultText(bgRun)),
		`${label}: bg content`,
	).toBe(normalizeGuidance(bgEnd.result.content[0].text));
	expect(
		stripUndefined(buildBackgroundDetails(bgRun)),
		`${label}: bg details`,
	).toEqual(stripUndefined(bg));

	setSystemTime(new Date(T0 + notifDetails.durationMs));
	bgRun.transition("completed", { summary: bgRun.resultText });
	expect(
		buildNotificationDetails(bgRun, 500),
		`${label}: notification details`,
	).toEqual(notifDetails as never);
	expect(
		formatTaskNotification(bgRun, 500) +
			`\nFull transcript available at: ${outputFile}`,
		`${label}: notification content`,
	).toBe(notifContent);
	expect(
		buildGetResultText(bgRun),
		`${label}: get_subagent_result content`,
	).toBe(getEnd.result.content[0].text);
	expect(
		stripUndefined(buildEventData(bgRun)),
		`${label}: subagents:completed payload`,
	).toEqual(stripUndefined(completedEvent) as never);

	// --- Lifecycle payloads ---
	expect(buildCreatedEvent(bgRun)).toEqual(
		stripUndefined(
			must(probe(records, "subagents:created"), "created"),
		) as never,
	);
	expect(buildStartedEvent(bgRun)).toEqual(
		stripUndefined(
			must(probe(records, "subagents:started"), "started"),
		) as never,
	);

	// --- Foreground run ---
	setSystemTime(T0);
	const fg: Rec = fgEnd.result.details;
	const fgText = String(fgEnd.result.content[0].text);
	// Our foreground result ends with the `Output file:` line; tintinweb's does not.
	const fgOutputFile = fgText.match(/^Output file:\s*(\S+)$/m)?.[1];
	const fgResult = fgText
		.replace(/\nOutput file: \S+$/, "")
		.split("\n\n")
		.slice(1)
		.join("\n\n");
	const fgRun = new SubagentRun({
		id: fg.agentId,
		subagentType: fg.subagentType,
		displayName: fg.displayName,
		description: fg.description,
		outputFile: fgOutputFile,
		maxTurns: fg.maxTurns,
		tags: fg.tags,
		startedAt: T0,
	});
	fgRun.toolUses = fg.toolUses;
	fgRun.turnCount = fg.turnCount;
	const fgUsage = parseTokens(fg.tokens as string);
	fgRun.lifetimeUsage.input = fgUsage.input;
	fgRun.resultText = fgResult;
	setSystemTime(new Date(T0 + fg.durationMs));
	fgRun.transition("completed", { summary: fgResult });

	expect(buildForegroundResultText(fgRun), `${label}: fg content`).toBe(
		fgEnd.result.content[0].text,
	);
	expect(
		stripUndefined(buildAgentDetails(fgRun)),
		`${label}: fg details`,
	).toEqual(stripUndefined(fg));
}

describe("playback: current builders reproduce recorded RPC traces", () => {
	it("matches the @tintinweb/pi-subagents oracle byte for byte", () => {
		replay("tintinweb");
	});

	it("matches this extension's own recorded trace", () => {
		replay("mine");
	});

	it("keeps the intentional fail-closed difference for unknown types", () => {
		const tintinweb = load("tintinweb");
		const mine = load("mine");
		const tintinwebBad = must(
			toolEnds(tintinweb, "Agent").find((record) =>
				record.result.details?.tags?.includes("twin"),
			),
			"tintinweb bad-type",
		);
		const mineBad = must(
			toolEnds(mine, "Agent").find((record) => record.isError === true),
			"mine bad-type",
		);
		// tintinweb falls back to general-purpose and succeeds; mine fails with no id.
		expect(tintinwebBad.isError).toBe(false);
		expect(tintinwebBad.result.details.subagentType).toBe("general-purpose");
		expect(mineBad.isError).toBe(true);
		expect(mineBad.result.details).toEqual({});
	});
});
