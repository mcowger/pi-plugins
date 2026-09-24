import { describe, expect, it } from "bun:test";
import { boundJson } from "../src/truncate.ts";

function byteLen(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

describe("boundJson", () => {
	it("returns a small value untouched", () => {
		const value = { a: 1, b: "hello", c: [1, 2, 3] };
		const result = boundJson(value, 1000);
		expect(result).toEqual({ value, truncated: false, bytes: byteLen(value) });
	});

	it("truncates a large single string field and stays within maxBytes", () => {
		const value = { text: "x".repeat(10_000) };
		const maxBytes = 500;
		const result = boundJson(value, maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.bytes).toBeLessThanOrEqual(maxBytes);
		const v = result.value as { text: string };
		expect(v.text).toContain("…[truncated");
	});

	it("truncates many medium strings, needing multiple loop iterations", () => {
		const value = {
			items: Array.from({ length: 50 }, (_, i) => ({ id: i, text: "m".repeat(300) })),
		};
		const maxBytes = 2000;
		const result = boundJson(value, maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.bytes).toBeLessThanOrEqual(maxBytes);
	});

	it("handles a circular reference without throwing", () => {
		const value: Record<string, unknown> = { a: 1 };
		value.self = value;
		expect(() => boundJson(value, 1000)).not.toThrow();
		const result = boundJson(value, 1000);
		expect(result.truncated).toBe(false);
		expect((result.value as { self: unknown }).self).toBe("[Circular]");
	});

	it("handles a circular reference nested inside an array", () => {
		const value: Record<string, unknown> = { list: [] as unknown[] };
		(value.list as unknown[]).push(value);
		const result = boundJson(value, 1000);
		const list = (result.value as { list: unknown[] }).list;
		expect(list[0]).toBe("[Circular]");
	});

	it("converts bigint to a string and drops functions", () => {
		const value = { big: 10n, fn: () => 1, kept: "ok" };
		const result = boundJson(value, 1000);
		expect(result.value).toEqual({ big: "10", kept: "ok" });
	});

	it("replaces binary buffers with a size placeholder", () => {
		const value = { buf: Buffer.from("hello world") };
		const result = boundJson(value, 1000);
		expect(result.value).toEqual({ buf: "[binary 11 bytes]" });
	});

	it("truncates an array longer than 200 items", () => {
		const value = { items: Array.from({ length: 500 }, (_, i) => i) };
		const result = boundJson(value, 1000);
		const items = (result.value as { items: unknown[] }).items;
		expect(items.length).toBe(201);
		expect(items[200]).toBe("[300 more items truncated]");
	});

	it("falls back to a minimal shape for pathological input that can't be split small enough", () => {
		const value = {
			type: "huge_event",
			blob: "q".repeat(5_000_000), // one gigantic unsplittable string
			nested: { a: { b: { c: { d: { e: "deep".repeat(1000) } } } } },
		};
		const maxBytes = 100;
		const result = boundJson(value, maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.value).toMatchObject({ type: "huge_event", truncated: true });
		expect((result.value as { originalBytes: number }).originalBytes).toBeGreaterThan(maxBytes);
		expect(result.bytes).toBe(byteLen(result.value));
	});

	it("bytes always reflects the byte length of the returned value", () => {
		const value = { text: "y".repeat(10_000) };
		const result = boundJson(value, 300);
		expect(result.bytes).toBe(byteLen(result.value));
	});
});
