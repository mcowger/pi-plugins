import { beforeAll, describe, expect, it } from "bun:test";
import { initBashParser, parseCommand } from "../../src/utils/bash-ast.js";
import { extractInterpreterSources } from "../../src/utils/interpreter-source.js";

beforeAll(async () => {
	await initBashParser((message) => console.warn(message));
});

async function extract(command: string) {
	const stages = await parseCommand(command);
	return extractInterpreterSources(stages[0]);
}

describe("extractInterpreterSources", () => {
	it("extracts Python source from -c", async () => {
		const result = await extract(`python3 -c 'open("/tmp/x", "w")'`);
		expect(result).toEqual({
			sources: [
				{
					language: "python",
					source: `open("/tmp/x", "w")`,
					interpreter: "python3",
					origin: "inline",
				},
			],
			unresolvedEffects: [],
		});
	});

	it("extracts Python source from a heredoc", async () => {
		const result = await extract("python3 - <<'PY'\nopen('/tmp/x', 'w')\nPY");
		expect(result.sources[0]).toEqual({
			language: "python",
			source: "open('/tmp/x', 'w')\n",
			interpreter: "python3",
			origin: "heredoc",
		});
		expect(result.unresolvedEffects).toEqual([]);
	});

	it("extracts JavaScript source from node --eval", async () => {
		const result = await extract(
			`node --eval 'require("fs").writeFileSync("/tmp/x", "x")'`,
		);
		expect(result.sources[0]?.language).toBe("javascript");
		expect(result.sources[0]?.interpreter).toBe("node");
	});

	it("uses the TypeScript grammar for Bun source", async () => {
		const result = await extract(`bun -e 'const path: string = "/tmp/x"'`);
		expect(result.sources[0]?.language).toBe("typescript");
	});

	it("unwraps env assignments", async () => {
		const result = await extract(
			`env NODE_ENV=test node -e 'console.log("ok")'`,
		);
		expect(result.sources[0]?.interpreter).toBe("node");
		expect(result.sources[0]?.source).toBe(`console.log("ok")`);
	});

	it("marks env working-directory changes unresolved", async () => {
		const result = await extract(
			`env --chdir /locked node -e 'console.log("ok")'`,
		);
		expect(result).toEqual({
			sources: [],
			unresolvedEffects: ["env changes the command working directory"],
		});
	});

	it("extracts a static nested shell command", async () => {
		const result = await extract(`bash -c 'python3 -c "print(1)"'`);
		expect(result.sources[0]).toEqual({
			language: "shell",
			source: `python3 -c "print(1)"`,
			interpreter: "bash",
			origin: "inline",
		});
	});

	it("marks dynamic evaluation source unresolved", async () => {
		const result = await extract(`python3 -c "$SOURCE"`);
		expect(result.sources).toEqual([]);
		expect(result.unresolvedEffects).toContain(
			"python3 evaluation source is dynamic",
		);
	});

	it("marks script files unresolved", async () => {
		const result = await extract("python3 ./script.py");
		expect(result.sources).toEqual([]);
		expect(result.unresolvedEffects).toEqual([
			"python3 script files are not yet analyzed",
		]);
	});

	it("rejects Python script or module execution before a static stdin source", async () => {
		const script = await extract("python3 ./script.py <<'PY'\nprint(1)\nPY");
		const module = await extract("python3 -m attacker <<'PY'\nprint(1)\nPY");
		expect(script).toEqual({
			sources: [],
			unresolvedEffects: ["python3 script files are not yet analyzed"],
		});
		expect(module).toEqual({
			sources: [],
			unresolvedEffects: ["python3 module execution is not analyzed"],
		});
	});

	it("rejects Node script and preload options around inline evaluation", async () => {
		const script = await extract(`node ./script.js -e 'console.log(1)'`);
		const leadingPreload = await extract(
			`node --require ./preload.js -e 'console.log(1)'`,
		);
		const trailingPreload = await extract(
			`node -e 'console.log(1)' --require ./preload.js`,
		);
		expect(script).toEqual({
			sources: [],
			unresolvedEffects: ["node script files are not yet analyzed"],
		});
		expect(leadingPreload).toEqual({
			sources: [],
			unresolvedEffects: ["node uses unsupported execution options"],
		});
		expect(trailingPreload).toEqual({
			sources: [],
			unresolvedEffects: [
				"node uses unsupported execution options after inline source",
			],
		});
	});

	it("rejects a shell script before -c source", async () => {
		const result = await extract(`bash ./script.sh -c 'echo ok'`);
		expect(result).toEqual({
			sources: [],
			unresolvedEffects: ["bash script files are not yet analyzed"],
		});
	});

	it("marks unavailable standard-input source unresolved", async () => {
		const stages = await parseCommand(`printf code | python3 -`);
		const result = extractInterpreterSources(stages[1]);
		expect(result.sources).toEqual([]);
		expect(result.unresolvedEffects).toEqual([
			"python3 standard-input source is not statically available",
		]);
	});

	it("does not flag incomplete ordinary non-interpreter commands", async () => {
		const result = await extract(`echo "$VALUE"`);
		expect(result).toEqual({ sources: [], unresolvedEffects: [] });
	});

	it("rejects source over the configured byte limit", async () => {
		const stages = await parseCommand(`node -e 'console.log("long")'`);
		const result = extractInterpreterSources(stages[0], {
			maxSourceBytes: 4,
		});
		expect(result.sources).toEqual([]);
		expect(result.unresolvedEffects[0]).toContain("exceeds the 4-byte");
	});
});
