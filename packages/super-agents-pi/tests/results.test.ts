import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeResult, formatRunResult, truncateUtf8 } from "../src/results.ts";
import type { RunRecord, RunStatus } from "../src/types.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "super-agents-pi-results-"));
	createdDirs.push(dir);
	return dir;
}

function baseRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "abcd1234",
		name: "scout",
		slug: "scout",
		prompt: "do the thing",
		background: false,
		parentToolCallId: "tc1",
		status: "completed",
		createdAt: 0,
		delivered: false,
		...overrides,
	};
}

describe("truncateUtf8", () => {
	it("returns the text unchanged when it already fits", () => {
		const result = truncateUtf8("hello", 100);
		expect(result).toEqual({ text: "hello", truncated: false, bytes: 5 });
	});

	it("truncates plain ASCII at the exact byte boundary", () => {
		const result = truncateUtf8("abcdefgh", 4);
		expect(result.text).toBe("abcd");
		expect(result.truncated).toBe(true);
		expect(result.bytes).toBe(4);
	});

	it("never splits a multi-byte UTF-8 code point", () => {
		// "é" is 2 bytes (0xC3 0xA9) in UTF-8. Cutting at 1 byte must back off to 0.
		const text = "é";
		const result = truncateUtf8(text, 1);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(1);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});

	it("cuts a multi-character string before a multi-byte character when the boundary lands mid-character", () => {
		// "a" + "é" (2 bytes) + "b": total 4 bytes. maxBytes=2 lands mid-"é" (byte offset 2 is
		// the second byte of "é", a continuation byte), so it must back off to just "a" (1 byte).
		const text = "aéb";
		const result = truncateUtf8(text, 2);
		expect(result.text).toBe("a");
		expect(result.truncated).toBe(true);
		expect(result.bytes).toBe(1);
	});

	it("handles 4-byte code points (emoji) without splitting", () => {
		const text = "😀x"; // 😀 is 4 bytes, "x" is 1 byte
		const result = truncateUtf8(text, 3);
		expect(result.text).toBe("");
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(3);
	});
});

describe("finalizeResult", () => {
	it("returns the text inline with no file written when it fits", async () => {
		const overflowRoot = await tempDir();
		const record = baseRecord();
		const result = await finalizeResult({
			record,
			text: "short result",
			maxResultBytes: 65536,
			overflowRoot,
			parentSessionId: "session-1",
		});
		expect(result).toEqual({ inlineText: "short result" });
	});

	it("writes the full text to an overflow file and returns a truncated inline text when too large", async () => {
		const overflowRoot = await tempDir();
		const record = baseRecord({ id: "zz999999" });
		const fullText = "x".repeat(1000);

		const result = await finalizeResult({
			record,
			text: fullText,
			maxResultBytes: 100,
			overflowRoot,
			parentSessionId: "session-1",
		});

		expect(result.outputPath).toBe(join(overflowRoot, "session-1", "zz999999.md"));
		expect(result.inlineText.length).toBeLessThanOrEqual(100);
		expect(fullText.startsWith(result.inlineText)).toBe(true);

		const written = await readFile(result.outputPath as string, "utf-8");
		expect(written).toBe(fullText);

		const st = await stat(result.outputPath as string);
		expect(st.mode & 0o777).toBe(0o600);
	});

	it("sanitizes the parentSessionId when building the overflow directory", async () => {
		const overflowRoot = await tempDir();
		const record = baseRecord();
		const result = await finalizeResult({
			record,
			text: "y".repeat(200),
			maxResultBytes: 10,
			overflowRoot,
			parentSessionId: "weird/session:id with spaces",
		});
		expect(result.outputPath).toBe(join(overflowRoot, "weird_session_id_with_spaces", "abcd1234.md"));
	});
});

describe("formatRunResult", () => {
	it("formats a completed run with output", () => {
		const record = baseRecord({ status: "completed" });
		const text = formatRunResult(record, "the answer is 42");
		expect(text).toBe("### scout (scout) — completed [id: abcd1234]\nthe answer is 42");
	});

	it("shows (no output) when inlineText is empty", () => {
		const record = baseRecord({ status: "completed" });
		const text = formatRunResult(record, "");
		expect(text).toBe("### scout (scout) — completed [id: abcd1234]\n(no output)");
	});

	it.each([
		"queued",
		"running",
		"completed",
		"failed",
		"aborted",
		"turn_limited",
	] as RunStatus[])("includes the status %s in the header", (status) => {
		const record = baseRecord({ status });
		const text = formatRunResult(record, "hi");
		expect(text.startsWith(`### scout (scout) — ${status} [id: abcd1234]`)).toBe(true);
	});

	it("appends an error line when record.error is set", () => {
		const record = baseRecord({ status: "failed", error: "boom" });
		const text = formatRunResult(record, "partial");
		expect(text).toBe("### scout (scout) — failed [id: abcd1234]\npartial\n[error: boom]");
	});

	it("does not append an error line when record.error is unset", () => {
		const record = baseRecord({ status: "completed" });
		const text = formatRunResult(record, "ok");
		expect(text).not.toContain("[error:");
	});

	it("appends an override-ignored note when record.overrideIgnored is true", () => {
		const record = baseRecord({ overrideIgnored: true });
		const text = formatRunResult(record, "ok");
		expect(text).toContain("[note: requested model/thinking ignored — agent 'scout' does not allow overrides]");
	});

	it("does not append an override-ignored note when unset", () => {
		const record = baseRecord();
		const text = formatRunResult(record, "ok");
		expect(text).not.toContain("[note:");
	});

	it("appends a truncation line with the full file byte size when outputPath is set", async () => {
		const overflowRoot = await tempDir();
		const record = baseRecord({ id: "ffff0000" });
		const fullText = "z".repeat(5000);
		const { inlineText, outputPath } = await finalizeResult({
			record,
			text: fullText,
			maxResultBytes: 200,
			overflowRoot,
			parentSessionId: "sess",
		});
		const finalized: RunRecord = { ...record, outputPath };

		const text = formatRunResult(finalized, inlineText);
		expect(text).toContain(`[output truncated — full result (5000 bytes): ${outputPath}]`);
	});

	it("combines error, truncation, and override-ignored lines together, in order", async () => {
		const overflowRoot = await tempDir();
		const record = baseRecord({ id: "eeee1111", status: "failed", error: "went wrong", overrideIgnored: true });
		const fullText = "w".repeat(300);
		const { inlineText, outputPath } = await finalizeResult({
			record,
			text: fullText,
			maxResultBytes: 50,
			overflowRoot,
			parentSessionId: "sess",
		});
		const finalized: RunRecord = { ...record, outputPath };

		const text = formatRunResult(finalized, inlineText);
		const lines = text.split("\n");
		expect(lines[0]).toBe("### scout (scout) — failed [id: eeee1111]");
		expect(lines[1]).toBe(inlineText);
		expect(lines[2]).toBe(`[output truncated — full result (300 bytes): ${outputPath}]`);
		expect(lines[3]).toBe("[error: went wrong]");
		expect(lines[4]).toBe("[note: requested model/thinking ignored — agent 'scout' does not allow overrides]");
	});
});
