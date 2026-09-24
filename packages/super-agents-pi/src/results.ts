import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "./types.ts";

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
	const full = Buffer.from(text, "utf-8");
	if (full.byteLength <= maxBytes) {
		return { text, truncated: false, bytes: full.byteLength };
	}

	let end = maxBytes;
	// Back off until we land on a UTF-8 code point boundary: a byte 0x80-0xBF
	// is a continuation byte, so cutting there would split a multi-byte sequence.
	while (end > 0 && (full[end] & 0xc0) === 0x80) {
		end -= 1;
	}

	const truncated = full.subarray(0, end);
	const truncatedText = truncated.toString("utf-8");
	return { text: truncatedText, truncated: true, bytes: Buffer.byteLength(truncatedText, "utf-8") };
}

function sanitize(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function finalizeResult(input: {
	record: RunRecord;
	text: string;
	maxResultBytes: number;
	overflowRoot: string;
	parentSessionId: string;
}): Promise<{ inlineText: string; outputPath?: string }> {
	const { record, text, maxResultBytes, overflowRoot, parentSessionId } = input;

	if (Buffer.byteLength(text, "utf-8") <= maxResultBytes) {
		return { inlineText: text };
	}

	const dir = path.join(overflowRoot, sanitize(parentSessionId));
	await mkdir(dir, { recursive: true });
	const outputPath = path.join(dir, `${record.id}.md`);
	await writeFile(outputPath, text, { encoding: "utf-8", mode: 0o600 });

	const { text: inlineText } = truncateUtf8(text, maxResultBytes);
	return { inlineText, outputPath };
}

export function formatRunResult(record: RunRecord, inlineText: string): string {
	const lines: string[] = [];
	lines.push(`### ${record.name} (${record.slug}) — ${record.status} [id: ${record.id}]`);
	lines.push(inlineText.length > 0 ? inlineText : "(no output)");

	if (record.outputPath) {
		let bytes = 0;
		try {
			bytes = statSync(record.outputPath).size;
		} catch {
			// file may be unreadable/removed; fall back to 0 rather than throw from a formatter
		}
		lines.push(`[output truncated — full result (${bytes} bytes): ${record.outputPath}]`);
	}

	if (record.error) {
		lines.push(`[error: ${record.error}]`);
	}

	if (record.overrideIgnored) {
		lines.push(`[note: requested model/thinking ignored — agent '${record.slug}' does not allow overrides]`);
	}

	return lines.join("\n");
}
