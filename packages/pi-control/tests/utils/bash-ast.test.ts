import { describe, expect, it, beforeAll } from "bun:test";
import { initBashParser, parseCommand } from "../../src/utils/bash-ast.js";

beforeAll(async () => {
	await initBashParser((msg) => console.warn(msg));
});

describe("parseCommand", () => {
	it("parses a simple command", async () => {
		const stages = await parseCommand("git status");
		expect(stages).toHaveLength(1);
		expect(stages[0].command).toBe("git status");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("parses a command with a redirect target", async () => {
		const stages = await parseCommand("echo hello > /tmp/out.txt");
		expect(stages).toHaveLength(1);
		expect(stages[0].redirectFiles).toContain("/tmp/out.txt");
	});

	it("parses a piped command into multiple stages", async () => {
		const stages = await parseCommand("cat file.txt | grep foo");
		expect(stages.length).toBeGreaterThanOrEqual(2);
	});

	it("parses && separated commands", async () => {
		const stages = await parseCommand("git add . && git commit -m 'msg'");
		expect(stages.length).toBeGreaterThanOrEqual(2);
	});

	it("skips fd redirects like 2>&1", async () => {
		const stages = await parseCommand("make 2>&1");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("returns a stage even for a bare command", async () => {
		const stages = await parseCommand("ls");
		expect(stages).toHaveLength(1);
		expect(stages[0].command).toBe("ls");
	});

	// Bug: path args like ~ were not extracted, so location resolution
	// always fell back to CWD instead of checking the actual target path.
	it("extracts ~ as a path arg", async () => {
		const stages = await parseCommand("ls -la ~");
		expect(stages[0].pathArgs).toContain("~");
	});

	it("extracts absolute path args", async () => {
		const stages = await parseCommand("cat /etc/hosts");
		expect(stages[0].pathArgs).toContain("/etc/hosts");
	});

	it("extracts multiple path args", async () => {
		const stages = await parseCommand("rm /tmp/foo /home/user/bar");
		expect(stages[0].pathArgs).toContain("/tmp/foo");
		expect(stages[0].pathArgs).toContain("/home/user/bar");
	});

	it("extracts ./ and ../ path args", async () => {
		const stages = await parseCommand("cp ./src ../dest");
		expect(stages[0].pathArgs).toContain("./src");
		expect(stages[0].pathArgs).toContain("../dest");
	});

	it("does not mistake a sed address range for an absolute path", async () => {
		const stages = await parseCommand(
			"sed -n '/private updateResponsesSnapshot/,/^  }$/p' src/services/inspectors/debug-logging.ts",
		);
		expect(stages[0].pathArgs).not.toContain(
			"/private updateResponsesSnapshot/,/^  }$/p",
		);
		expect(stages[0].pathArgs).toEqual([]);
	});

	it("retains explicit sed script files and input paths", async () => {
		const stages = await parseCommand("sed -f /tmp/rules.sed /tmp/input.txt");
		expect(stages[0].pathArgs).toEqual(["/tmp/rules.sed", "/tmp/input.txt"]);
	});

	it("does not extract flags as path args", async () => {
		const stages = await parseCommand("ls -la --color=auto");
		expect(stages[0].pathArgs).toHaveLength(0);
	});

	it("does not extract bare words as path args", async () => {
		const stages = await parseCommand("git status");
		expect(stages[0].pathArgs).toHaveLength(0);
	});

	// Regression: 2>/dev/null was treated as a file redirect target, causing
	// /dev/null to be checked against location policies and denied.
	it("does not extract numeric fd redirects like 2>/dev/null as redirect files", async () => {
		const stages = await parseCommand("ls /tmp 2>/dev/null");
		expect(stages[0].redirectFiles).toHaveLength(0);
	});

	it("still extracts plain stdout redirects as redirect files", async () => {
		const stages = await parseCommand("ls /tmp > /tmp/out.txt");
		expect(stages[0].redirectFiles).toContain("/tmp/out.txt");
	});

	it("extracts structured static arguments", async () => {
		const stages = await parseCommand(
			`node -e 'require("fs").writeFileSync("/tmp/x", "x")'`,
		);
		expect(stages[0].args).toEqual([
			{ value: "node", static: true },
			{ value: "-e", static: true },
			{
				value: `require("fs").writeFileSync("/tmp/x", "x")`,
				static: true,
			},
		]);
		expect(stages[0].analysisIncomplete).toBe(false);
	});

	it("marks expanded arguments as incomplete", async () => {
		const stages = await parseCommand(`python3 -c "$SOURCE"`);
		expect(stages[0].args[2].static).toBe(false);
		expect(stages[0].analysisIncomplete).toBe(true);
	});

	it("extracts a quoted heredoc body as embedded source", async () => {
		const stages = await parseCommand(
			"python3 - <<'PY'\nopen('/outside/x', 'w')\nPY",
		);
		expect(stages).toHaveLength(1);
		expect(stages[0].command).toBe("python3 -");
		expect(stages[0].embeddedSources).toEqual([
			{
				kind: "heredoc",
				text: "open('/outside/x', 'w')\n",
				static: true,
			},
		]);
		expect(stages[0].analysisIncomplete).toBe(false);
	});

	it("extracts a here-string as embedded source", async () => {
		const stages = await parseCommand(
			`python3 - <<< 'open("/outside/x", "w")'`,
		);
		expect(stages[0].embeddedSources).toEqual([
			{
				kind: "herestring",
				text: `open("/outside/x", "w")`,
				static: true,
			},
		]);
	});

	it("marks indirect heredoc pipelines as incomplete", async () => {
		const stages = await parseCommand(
			"cat <<EOF | python3 -\nopen('/outside/x', 'w')\nEOF",
		);
		expect(stages[0].embeddedSources[0]?.text).toBe(
			"open('/outside/x', 'w')\n",
		);
		expect(stages[0].analysisIncomplete).toBe(true);
	});
});
