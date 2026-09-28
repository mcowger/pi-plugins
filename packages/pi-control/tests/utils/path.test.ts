import { afterAll, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizePath,
	expandHome,
	normalizePath,
} from "../../src/utils/path.js";

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

const tempRoots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-controls-path-"));
	tempRoots.push(root);
	return root;
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("canonicalizePath", () => {
	it("resolves a symlinked directory to its real target", () => {
		const root = makeRoot();
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);

		expect(canonicalizePath(link, root)).toBe(realpathSync(real));
	});

	it("resolves a symlinked file to its real path", () => {
		const root = makeRoot();
		const realFile = join(root, "secret.txt");
		writeFileSync(realFile, "x");
		const link = join(root, "alias.txt");
		symlinkSync(realFile, link);

		expect(canonicalizePath(link, root)).toBe(realpathSync(realFile));
	});

	it("resolves through a symlinked parent for a not-yet-existing target", () => {
		const root = makeRoot();
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);

		expect(canonicalizePath(join(link, "new.txt"), root)).toBe(
			join(realpathSync(real), "new.txt"),
		);
	});

	it("resolves relative paths against a canonical cwd", () => {
		const root = makeRoot();

		expect(canonicalizePath("child", root)).toBe(
			join(realpathSync(root), "child"),
		);
	});

	it("falls back to the normalized path when no ancestor resolves", () => {
		expect(canonicalizePath("/nonexistent-pi-controls/foo", "/tmp")).toBe(
			"/nonexistent-pi-controls/foo",
		);
	});
});
