import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { expandHome, normalizePath } from "../../src/utils/path.js";

describe("expandHome", () => {
	it("expands ~ to home dir", () => {
		expect(expandHome("~")).toBe(homedir());
	});

	it("expands ~/foo", () => {
		expect(expandHome("~/foo")).toBe(`${homedir()}/foo`);
	});

	it("leaves absolute paths alone", () => {
		expect(expandHome("/tmp/foo")).toBe("/tmp/foo");
	});

	it("leaves relative paths alone", () => {
		expect(expandHome("foo/bar")).toBe("foo/bar");
	});
});

describe("normalizePath", () => {
	it("resolves relative paths against cwd", () => {
		expect(normalizePath("foo", "/home/user/project")).toBe(
			"/home/user/project/foo",
		);
	});

	it("expands ~ and returns absolute path", () => {
		expect(normalizePath("~/docs", "/irrelevant")).toBe(`${homedir()}/docs`);
	});

	it("returns absolute paths unchanged (but resolved)", () => {
		expect(normalizePath("/tmp/../etc", "/irrelevant")).toBe("/etc");
	});
});
