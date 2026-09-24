import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { extensionNames, filterExtensions } from "../src/extension-names.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "super-agents-pi-extnames-"));
	createdDirs.push(dir);
	return dir;
}

describe("extensionNames", () => {
	it("derives the package name from a git-installed extension path", () => {
		const p = join("home", "x", ".pi", "agent", "extensions", "git", "github.com", "someuser", "somepkg", "index.ts");
		expect(extensionNames(sep + p)).toEqual(["somepkg"]);
	});

	it("derives the package name from a scoped npm path", () => {
		const p = join("proj", "node_modules", "@scope", "pkg-name", "dist", "index.js");
		expect(extensionNames(sep + p)).toEqual(["pkg-name"]);
	});

	it("derives the package name from an unscoped npm path", () => {
		const p = join("proj", "node_modules", "pkg-name", "dist", "index.js");
		expect(extensionNames(sep + p)).toEqual(["pkg-name"]);
	});

	it("derives the name from a local extensions/<name>.ts file", () => {
		const p = join("home", "x", ".pi", "agent", "extensions", "foo.ts");
		expect(extensionNames(sep + p)).toEqual(["foo"]);
	});

	it("derives the name from a local extensions/<name>/index.ts directory", () => {
		const p = join("home", "x", ".pi", "agent", "extensions", "foo", "index.ts");
		expect(extensionNames(sep + p)).toEqual(["foo"]);
	});

	it("falls back to the parent directory name when nothing else matches", () => {
		const p = join("home", "x", "somewhere", "myext", "index.ts");
		expect(extensionNames(sep + p)).toEqual(["myext"]);
	});

	it("lowercases names", () => {
		const p = join("proj", "node_modules", "PkgName", "index.js");
		expect(extensionNames(sep + p)).toEqual(["pkgname"]);
	});

	it("includes the deduped package short name alongside the path-derived name", async () => {
		const dir = await tempDir();
		const pkgDir = join(dir, "mypkg");
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "@scope/my-pkg", pi: { extensions: ["./index.ts"] } }),
			"utf-8",
		);
		const entry = join(pkgDir, "index.ts");
		await writeFile(entry, "export default () => {};", "utf-8");

		const names = extensionNames(entry);
		expect(names).toContain("my-pkg");
		expect(names).toContain("mypkg"); // path-derived: parent dir fallback
		expect(names).toHaveLength(2);
	});

	it("dedupes when the path-derived name equals the package short name", async () => {
		const dir = await tempDir();
		const pkgDir = join(dir, "extensions", "samename");
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "samename", pi: { extensions: ["./index.ts"] } }),
			"utf-8",
		);
		const entry = join(pkgDir, "index.ts");
		await writeFile(entry, "export default () => {};", "utf-8");

		expect(extensionNames(entry)).toEqual(["samename"]);
	});

	it("does not resolve a package name when no package.json declares the entry as a pi extension", async () => {
		const dir = await tempDir();
		const pkgDir = join(dir, "notanextension");
		await mkdir(pkgDir, { recursive: true });
		await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "notanextension" }), "utf-8");
		const entry = join(pkgDir, "index.ts");
		await writeFile(entry, "export default () => {};", "utf-8");

		expect(extensionNames(entry)).toEqual(["notanextension"]);
	});
});

interface FakeExtension {
	path: string;
	resolvedPath: string;
}

function ext(name: string, dir: string): FakeExtension {
	const p = join(dir, "extensions", name, "index.ts");
	return { path: p, resolvedPath: p };
}

describe("filterExtensions", () => {
	it("always drops extensions under the own package dir, regardless of spec", async () => {
		const dir = await tempDir();
		const ownDir = join(dir, "own-package");
		const own = ext("self", ownDir);
		const other = ext("other", dir);

		const resultAll = filterExtensions([own, other], "all", [], ownDir);
		expect(resultAll.kept).toEqual([other]);

		const resultList = filterExtensions([own, other], ["self", "other"], [], ownDir);
		expect(resultList.kept).toEqual([other]);
		// "self" was requested but excluded by the own-package rule, so it never
		// gets a chance to match, and is reported unmatched.
		expect(resultList.unmatched).toEqual(["self"]);
	});

	it('spec "none" keeps nothing', async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const b = ext("b", dir);
		const result = filterExtensions([a, b], "none", [], join(dir, "own"));
		expect(result.kept).toEqual([]);
		expect(result.unmatched).toEqual([]);
	});

	it('spec "all" keeps everything except excluded names', async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const b = ext("b", dir);
		const result = filterExtensions([a, b], "all", ["a"], join(dir, "own"));
		expect(result.kept).toEqual([b]);
		expect(result.unmatched).toEqual([]);
	});

	it('spec "all" reports unmatched exclude names', async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const result = filterExtensions([a], "all", ["nonexistent"], join(dir, "own"));
		expect(result.kept).toEqual([a]);
		expect(result.unmatched).toEqual(["nonexistent"]);
	});

	it("a list spec keeps only the requested extensions", async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const b = ext("b", dir);
		const c = ext("c", dir);
		const result = filterExtensions([a, b, c], ["a", "c"], [], join(dir, "own"));
		expect(result.kept).toEqual([a, c]);
		expect(result.unmatched).toEqual([]);
	});

	it("a list spec reports names that matched nothing", async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const result = filterExtensions([a], ["a", "missing"], [], join(dir, "own"));
		expect(result.kept).toEqual([a]);
		expect(result.unmatched).toEqual(["missing"]);
	});

	it("list and exclude names are matched case-insensitively", async () => {
		const dir = await tempDir();
		const a = ext("a", dir);
		const result = filterExtensions([a], ["A"], [], join(dir, "own"));
		expect(result.kept).toEqual([a]);
	});
});
