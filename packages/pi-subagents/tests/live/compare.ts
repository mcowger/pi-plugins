/**
 * Compare two recorded live traces at the contract level.
 *
 * Canonicalizes both traces, masking run-dependent values (ids, paths, token
 * counts, durations), and reports structural differences. The known intentional
 * deviations are excluded: the unknown-type fallback and the extra
 * `subagents:child:*` events. Lifecycle events are compared as a set so payload
 * order does not matter.
 *
 * Usage:
 *   bun tests/live/compare.ts [mine] [tintinweb]
 *
 * Reads `<PI_LIVE_DIR>/<label>/<label>-rpc.jsonl` and exits non-zero when the
 * canonical transcripts differ.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.PI_LIVE_DIR ?? "/tmp/pi-subagents-live";

type Rec = Record<string, any>;

function load(label: string): Rec[] {
	const path = join(ROOT, label, `${label}-rpc.jsonl`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function maskText(text: string): string {
	return (
		text
			// Absolute paths first, so the differing transcript extensions disappear
			// and ids inside a path are masked with it. Not XML closing tags.
			.replace(/(?<![<\w])\/(?!>)[^\s"'<>]+/g, "<PATH>")
			// UUIDs (5-segment) and tintinweb's shorter run ids (3-segment).
			.replace(
				/[0-9a-f]{8}-[0-9a-f]{3,4}-[0-9a-f]{3,4}-[0-9a-f]{3,4}-[0-9a-f]{3,4}/gi,
				"<ID>",
			)
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}/gi, "<ID>")
			.replace(/[0-9a-f]{12}/g, "<ID>")
			.replace(/call_[0-9a-f]+/g, "<CALL>")
			.replace(/in \d+\.\d+s/g, "in <DUR>")
			.replace(/Duration: [^\n|]+/g, "Duration: <DUR>")
			.replace(/\d+(\.\d+)?(k|M)? token/g, "<TOKENS>")
			.replace(/Tool uses: \d+/g, "Tool uses: N")
			.replace(/Context: \d+%/g, "Context: N%")
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
		for (const key of Object.keys(value).sort()) {
			out[key] = canonical((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
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
	lines: string[];
	events: string[];
}

function canonicalTranscript(records: Rec[]): Transcript {
	const lines: string[] = [];
	const events: string[] = [];
	for (const record of records) {
		if (record.type === "extension_ui_request") {
			const message = String(record.message ?? "");
			if (message.startsWith("PROBE subagents:child:")) continue;
			if (!message.startsWith("PROBE ")) continue;
			if (message.includes("cmp bad type")) continue;
			const payload = message.slice("PROBE ".length);
			const channel = payload.slice(0, payload.indexOf(" "));
			let canonicalPayload = payload.slice(payload.indexOf("{"));
			try {
				canonicalPayload = JSON.stringify(
					canonical(JSON.parse(payload.slice(payload.indexOf("{")))),
				);
			} catch {
				// Leave non-JSON payloads as text.
			}
			events.push(maskText(`PROBE ${channel} ${canonicalPayload}`));
			continue;
		}
		if (record.type === "tool_execution_start") {
			if ((record.args as Rec | undefined)?.subagent_type === "does-not-exist")
				continue;
			lines.push(
				`START ${record.toolName} ${JSON.stringify(canonical(record.args))}`,
			);
			continue;
		}
		if (record.type === "tool_execution_end") {
			if (isUnknownTypeResult(record)) continue;
			const text = record.result?.content?.[0]?.text ?? "";
			lines.push(
				`END ${record.toolName} err=${record.isError}\n${maskText(text)}\n${JSON.stringify(canonical(record.result?.details ?? null))}`,
			);
			continue;
		}
		if (record.type === "message_end" && record.message?.role === "custom") {
			// `maxTurns` is an optional passthrough field that tintinweb emits
			// inconsistently for background runs; Paseo ignores it.
			const details = { ...(record.message.details as Rec | undefined) };
			delete details.maxTurns;
			lines.push(
				`CUSTOM ${record.message.customType}\n${maskText(record.message.content ?? "")}\n${JSON.stringify(canonical(details))}`,
			);
		}
	}
	return { lines, events: events.sort() };
}

const mine = canonicalTranscript(load(process.argv[2] ?? "mine"));
const oracle = canonicalTranscript(load(process.argv[3] ?? "tintinweb"));
const left = [...mine.lines, ...mine.events];
const right = [...oracle.lines, ...oracle.events];

const max = Math.max(left.length, right.length);
const slice = Number(process.env.PI_LIVE_SLICE ?? 300);
let differences = 0;
for (let i = 0; i < max; i++) {
	if (left[i] !== right[i]) {
		differences++;
		console.log(`--- mismatch at record ${i}`);
		console.log(
			`  mine:      ${String(left[i]).replace(/\n/g, "\\n").slice(0, slice)}`,
		);
		console.log(
			`  tintinweb: ${String(right[i]).replace(/\n/g, "\\n").slice(0, slice)}`,
		);
	}
}
if (differences === 0) {
	console.log(`OK: ${left.length} canonical records match`);
	process.exit(0);
}
console.log(`${differences} difference(s)`);
process.exit(1);
