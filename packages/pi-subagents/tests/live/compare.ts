/**
 * Compare two recorded live traces at the contract level.
 *
 * Canonicalizes both traces, masking run-dependent values (ids, paths, token
 * counts, durations), projecting details onto the fields Paseo actually reads,
 * and reporting structural differences. Known intentional deviations are
 * excluded: explanatory background-result text, notification presentation,
 * the unknown-type fallback, terminal `steered` status normalization, and the
 * extra `subagents:child:*` events.
 *
 * tintinweb varies run-to-run in optional, passthrough fields (`cost`,
 * `modelName`, `usage`, `maxTurns`) and in lifecycle-event emission, so those are
 * informational here; the strict comparison covers tool-result contract
 * markers/details and notification details. Notification text differs by
 * design. Our lifecycle payloads are pinned exactly by playback tests.
 *
 * Usage:
 *   bun tests/live/compare.ts [scenario] [mine] [tintinweb]
 *
 * Reads `<PI_LIVE_DIR>/<label>/<scenario>/<label>-rpc.jsonl` and exits non-zero
 * when the canonical transcripts differ.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.PI_LIVE_DIR ?? "/tmp/pi-subagents-live";

type Rec = Record<string, any>;

function load(label: string, scenario: string): Rec[] {
	const path = join(ROOT, label, scenario, `${label}-rpc.jsonl`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function maskText(text: string): string {
	return (
		text
			.replace(/(?<![<\w])\/(?!>)[^\s"'<>]+/g, "<PATH>")
			.replace(
				/[0-9a-f]{8}-[0-9a-f]{3,4}-[0-9a-f]{3,4}-[0-9a-f]{3,4}-[0-9a-f]{3,4}/gi,
				"<ID>",
			)
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}/gi, "<ID>")
			.replace(/[0-9a-f]{12}/g, "<ID>")
			.replace(/call_[0-9a-f]+/g, "<CALL>")
			// `<summary>` and `<result>` carry model-generated prose, not contract fields.
			.replace(/<summary>[\s\S]*?<\/summary>/g, "<summary><S></summary>")
			.replace(/<result>[\s\S]*?<\/result>/g, "<result><R></result>")
			.replace(/in \d+\.\d+s/g, "in <DUR>")
			.replace(/Duration: [^\n|]+/g, "Duration: <DUR>")
			.replace(/\d+(\.\d+)?(k|M)? token/g, "<TOKENS>")
			.replace(/Tool uses: \d+/g, "Tool uses: N")
			.replace(/Context: \d+%/g, "Context: N%")
			.replace(/context \d+% full/g, "context N% full")
			.replace(
				/<total_tokens>\d+<\/total_tokens>/g,
				"<total_tokens>N</total_tokens>",
			)
			.replace(/<tool_uses>\d+<\/tool_uses>/g, "<tool_uses>N</tool_uses>")
			.replace(
				/<context_percent>\d+<\/context_percent>/g,
				"<context_percent>N</context_percent>",
			)
			.replace(
				/<duration_ms>\d+<\/duration_ms>/g,
				"<duration_ms>N</duration_ms>",
			)
	);
}

function canonical(value: unknown): unknown {
	if (typeof value === "string") return maskText(value);
	if (typeof value === "number") return "<N>";
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort())
			out[key] = canonical((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

/** Fields the Paseo adapter reads, plus the stable tintinweb metrics. */
const BACKGROUND_DETAIL_KEYS = [
	"agentId",
	"description",
	"displayName",
	"durationMs",
	"status",
	"subagentType",
	"tags",
	"tokens",
	"toolUses",
];
const FOREGROUND_DETAIL_KEYS = [
	...BACKGROUND_DETAIL_KEYS,
	"turnCount",
	"maxTurns",
];
const NOTIFICATION_KEYS = [
	"id",
	"description",
	"status",
	"toolUses",
	"turnCount",
	"totalTokens",
	"durationMs",
	"outputFile",
	"resultPreview",
	"error",
];

function project(
	details: Rec | null | undefined,
	keys: readonly string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (details && key in details) out[key] = details[key];
	}
	return out;
}

function isBackgroundDetails(details: Rec | undefined): boolean {
	return details?.status === "background";
}

function canonicalBackgroundResultText(text: string): string {
	const withoutNote = text.replace(
		/^Note: run_in_background is deprecated and ignored;[^\n]*\n\n/,
		"",
	);
	const lines = withoutNote.split("\n");
	const outputFileLine = lines.findIndex((line) =>
		/^Output file:\s*\S+$/.test(line),
	);
	return maskText(
		outputFileLine < 0
			? withoutNote
			: lines.slice(0, outputFileLine + 1).join("\n"),
	);
}

/** The unknown-type call: tintinweb falls back, this extension fails closed. */
function isUnknownTypeResult(record: Rec): boolean {
	if (record.type !== "tool_execution_end" || record.toolName !== "Agent")
		return false;
	const details = record.result?.details as Rec | undefined;
	return record.isError === true
		? Object.keys(details ?? {}).length === 0
		: details?.tags?.includes("twin") === true;
}

interface Transcript {
	strict: string[];
	events: string[];
}

function canonicalTranscript(records: Rec[]): Transcript {
	const strict: string[] = [];
	const events: string[] = [];
	for (const record of records) {
		if (record.type === "extension_ui_request") {
			const message = String(record.message ?? "");
			if (message.startsWith("PROBE subagents:child:")) continue;
			if (!message.startsWith("PROBE ")) continue;
			if (message.includes("cmp bad type")) continue;
			events.push(maskText(message.slice(0, message.indexOf("{"))));
			continue;
		}
		if (record.type === "tool_execution_start") {
			if ((record.args as Rec | undefined)?.subagent_type === "does-not-exist")
				continue;
			const args = canonical(record.args) as Record<string, unknown>;
			delete args.run_in_background;
			strict.push(`START ${record.toolName} ${JSON.stringify(args)}`);
			continue;
		}
		if (record.type === "tool_execution_end") {
			if (isUnknownTypeResult(record)) continue;
			const text = record.result?.content?.[0]?.text ?? "";
			const details = record.result?.details as Rec | null | undefined;
			const keys = isBackgroundDetails(details ?? undefined)
				? BACKGROUND_DETAIL_KEYS
				: FOREGROUND_DETAIL_KEYS;
			const projected = details == null ? null : project(details, keys);
			const canonicalText =
				record.toolName === "Agent" && isBackgroundDetails(details ?? undefined)
					? canonicalBackgroundResultText(text)
					: maskText(text);
			strict.push(
				`END ${record.toolName} err=${record.isError}\n${canonicalText}\n${JSON.stringify(canonical(projected))}`,
			);
			continue;
		}
		if (record.type === "message_end" && record.message?.role === "custom") {
			const details = project(record.message.details, NOTIFICATION_KEYS);
			// A soft turn-limit wrap-up is terminal, but Paseo's descriptor enum
			// represents that outcome as `completed`.
			if (details.status === "steered") details.status = "completed";
			// resultPreview is model-generated prose, not a contract field.
			if ("resultPreview" in details) details.resultPreview = "<RESULT>";
			strict.push(
				`CUSTOM ${record.message.customType}\n${JSON.stringify(canonical(details))}`,
			);
		}
	}
	return { strict: strict.sort(), events: events.sort() };
}

const scenario = process.argv[2] ?? "contract";
const mine = canonicalTranscript(load(process.argv[3] ?? "mine", scenario));
const oracle = canonicalTranscript(
	load(process.argv[4] ?? "tintinweb", scenario),
);

const max = Math.max(mine.strict.length, oracle.strict.length);
const slice = Number(process.env.PI_LIVE_SLICE ?? 300);
let differences = 0;
for (let i = 0; i < max; i++) {
	if (mine.strict[i] !== oracle.strict[i]) {
		differences++;
		console.log(`--- mismatch at record ${i}`);
		console.log(
			`  mine:      ${String(mine.strict[i]).replace(/\n/g, "\\n").slice(0, slice)}`,
		);
		console.log(
			`  tintinweb: ${String(oracle.strict[i]).replace(/\n/g, "\\n").slice(0, slice)}`,
		);
	}
}
const countByChannel = (events: string[]) => {
	const counts = new Map<string, number>();
	for (const event of events) {
		const channel = event.split(" ")[1] ?? event;
		counts.set(channel, (counts.get(channel) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([channel, count]) => `${channel}x${count}`)
		.sort()
		.join(", ");
};
console.log(`events mine:      ${countByChannel(mine.events)}`);
console.log(`events tintinweb: ${countByChannel(oracle.events)}`);
if (differences === 0) {
	console.log(
		`OK: ${mine.strict.length} contract records match (events informational)`,
	);
	process.exit(0);
}
console.log(`${differences} contract difference(s)`);
process.exit(1);
