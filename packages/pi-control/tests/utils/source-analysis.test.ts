import { describe, expect, it } from "bun:test";
import { analyzeSource } from "../../src/utils/source-analysis.js";

const options = { cwd: "/workspace" };

describe("analyzeSource — Python", () => {
	it("finds Path.write_text with a literal path", async () => {
		const result = await analyzeSource(
			"python",
			`from pathlib import Path\nPath("/outside/out.txt").write_text("x")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Python Path.write_text",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("finds open write modes", async () => {
		const result = await analyzeSource(
			"python",
			`path = "/outside/out.txt"\nopen(path, mode="w").write("x")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Python open(w)",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("classifies Path.open write modes against the receiver path", async () => {
		const result = await analyzeSource(
			"python",
			`from pathlib import Path\nPath("/outside/out.txt").open("a")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Python Path.open(a)",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("resolves literal os.path.join paths", async () => {
		const result = await analyzeSource(
			"python",
			`import os\nopen(os.path.join("/outside", "out.txt"), "w")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Python open(w)",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("marks a dynamic write path unresolved", async () => {
		const result = await analyzeSource(
			"python",
			`open(get_path(), "w")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: null,
			evidence: "Python open(w)",
		});
		expect(result.unresolvedEffects).toContain(
			"Python open(w) has a dynamic path",
		);
		expect(result.unresolvedEffects).toContain("Unknown Python call: get_path");
	});

	it("classifies simple read-only source without uncertainty", async () => {
		const result = await analyzeSource(
			"python",
			`from pathlib import Path\nprint(Path("/tmp/x").read_text())`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "read",
			path: "/tmp/x",
			evidence: "Python Path.read_text",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("trusts pure standard-library imports and string methods", async () => {
		const result = await analyzeSource(
			"python",
			`import io\nimport re\ns = re.sub("-", "_", "a-b")\nprint(s.replace("_", "-"))\nbuffer = io.StringIO("ok")`,
			options,
		);
		expect(result).toEqual({
			findings: [],
			unresolvedEffects: [],
			parseErrors: [],
		});
	});

	it("continues to identify standard-library file and process effects", async () => {
		const result = await analyzeSource(
			"python",
			`import io\nimport os\nio.open("/outside/out.txt", "w")\nos.replace("/outside/old.txt", "/outside/new.txt")\nos.system("echo hello")`,
			options,
		);
		expect(result.findings).toEqual(
			expect.arrayContaining([
				{
					capability: "write",
					path: "/outside/out.txt",
					evidence: "Python open(w)",
				},
				{
					capability: "write",
					path: "/outside/old.txt",
					evidence: "Python os.replace",
				},
				{
					capability: "write",
					path: "/outside/new.txt",
					evidence: "Python os.replace",
				},
				{
					capability: "execute",
					path: null,
					evidence: "Python os.system",
				},
			]),
		);
		expect(result.unresolvedEffects).toEqual([
			"Python os.system has a dynamic path",
		]);
	});

	it("marks syntax errors unresolved", async () => {
		const result = await analyzeSource("python", `open("/tmp/x",`, options);
		expect(result.parseErrors).toContain(
			"python source contains syntax errors",
		);
		expect(result.unresolvedEffects).toContain(
			"python source contains syntax errors",
		);
	});

	it("marks unknown imports and calls unresolved", async () => {
		const result = await analyzeSource(
			"python",
			`import custom_module\ncustom_module.run()`,
			options,
		);
		expect(result.unresolvedEffects).toContain(
			"Python import executes unanalyzed module: custom_module",
		);
		expect(result.unresolvedEffects).toContain(
			"Unknown Python call: custom_module.run",
		);
	});
});

describe("analyzeSource — JavaScript and TypeScript", () => {
	it("finds a CommonJS fs write", async () => {
		const result = await analyzeSource(
			"javascript",
			`require("fs").writeFileSync("/outside/out.txt", "x")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Node fs.writeFileSync",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("tracks an imported fs alias and constant path", async () => {
		const result = await analyzeSource(
			"javascript",
			`import { writeFileSync as write } from "node:fs";\nconst path = "/outside/out.txt";\nwrite(path, "x");`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Node fs.writeFileSync",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("tracks CommonJS module and destructured aliases", async () => {
		const moduleResult = await analyzeSource(
			"javascript",
			`const fs = require("fs"); fs.writeFileSync("/outside/a", "x")`,
			options,
		);
		const destructuredResult = await analyzeSource(
			"javascript",
			`const { writeFileSync: write } = require("fs"); write("/outside/b", "x")`,
			options,
		);
		expect(moduleResult.findings[0]?.path).toBe("/outside/a");
		expect(destructuredResult.findings[0]?.path).toBe("/outside/b");
		expect(moduleResult.unresolvedEffects).toEqual([]);
		expect(destructuredResult.unresolvedEffects).toEqual([]);
	});

	it("resolves paths composed through a default-imported path module", async () => {
		const result = await analyzeSource(
			"javascript",
			`import path from "node:path"; import { writeFileSync } from "node:fs"; writeFileSync(path.join("/outside", "out.txt"), "x")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Node fs.writeFileSync",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("treats static JSON imports as reads rather than executable modules", async () => {
		const requireResult = await analyzeSource(
			"javascript",
			`const packages = require("/tmp/pi-packages.json"); console.log(packages.length);`,
			options,
		);
		const importResult = await analyzeSource(
			"javascript",
			`import packages from "./package.json"; console.log(packages.name);`,
			options,
		);
		expect(requireResult.findings).toContainEqual({
			capability: "read",
			path: "/tmp/pi-packages.json",
			evidence: "JavaScript require JSON",
		});
		expect(requireResult.unresolvedEffects).toEqual([]);
		expect(importResult.findings).toContainEqual({
			capability: "read",
			path: "./package.json",
			evidence: "JavaScript JSON import",
		});
		expect(importResult.unresolvedEffects).toEqual([]);
	});

	it("trusts Node runtime helpers and Bun pure APIs", async () => {
		const nodeResult = await analyzeSource(
			"javascript",
			`import { format } from "node:util"; import os from "node:os"; console.log(format("%s-%s", os.platform(), "ok"));`,
			options,
		);
		const bunResult = await analyzeSource(
			"typescript",
			`const id = Bun.hash("input"); console.log(Bun.escapeHTML(String(id)));`,
			options,
		);
		expect(nodeResult.unresolvedEffects).toEqual([]);
		expect(bunResult.unresolvedEffects).toEqual([]);
	});

	it("continues to identify Node filesystem and process effects", async () => {
		const result = await analyzeSource(
			"javascript",
			`import fs from "node:fs"; import childProcess from "node:child_process"; fs.openSync("/outside/out.txt", "w"); childProcess.execFile("echo", ["ok"]);`,
			options,
		);
		expect(result.findings).toEqual(
			expect.arrayContaining([
				{
					capability: "write",
					path: "/outside/out.txt",
					evidence: "Node fs.openSync(w)",
				},
				{
					capability: "execute",
					path: null,
					evidence: "JavaScript child_process.execFile",
				},
			]),
		);
		expect(result.unresolvedEffects).toEqual([
			"JavaScript child_process.execFile has a dynamic path",
		]);
	});

	it("finds Bun.write in TypeScript", async () => {
		const result = await analyzeSource(
			"typescript",
			`const path: string = "/outside/out.txt"; Bun.write(path, "x")`,
			options,
		);
		expect(result.findings).toContainEqual({
			capability: "write",
			path: "/outside/out.txt",
			evidence: "Bun.write",
		});
	});

	it("classifies console output as pure", async () => {
		const result = await analyzeSource(
			"javascript",
			`console.log("ok")`,
			options,
		);
		expect(result).toEqual({
			findings: [],
			unresolvedEffects: [],
			parseErrors: [],
		});
	});

	it("marks dynamic writes and subprocess-like unknowns unresolved", async () => {
		const result = await analyzeSource(
			"javascript",
			`require("fs").writeFileSync(getPath(), "x")`,
			options,
		);
		expect(result.findings[0]?.path).toBe(null);
		expect(result.unresolvedEffects).toContain(
			"Node fs.writeFileSync has a dynamic path",
		);
		expect(result.unresolvedEffects).toContain(
			"Unknown JavaScript call: getPath",
		);
	});
});
