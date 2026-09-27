import { describe, expect, it } from "bun:test";
import {
	detectEvalSources,
	type EvalDetection,
} from "../../src/utils/eval-detection.js";
import type { CommandStage, EmbeddedSource } from "../../src/utils/bash-ast.js";

function arg(value: string, stationary = true) {
	return { value, static: stationary };
}

function stage(
	args: ReturnType<typeof arg>[],
	embeddedSources: EmbeddedSource[] = [],
): CommandStage {
	return {
		command: args.map((a) => a.value).join(" "),
		args,
		redirectFiles: [],
		pathArgs: [],
		embeddedSources,
	};
}

function heredoc(text: string, stationary = true): EmbeddedSource {
	return { kind: "heredoc", text, static: stationary };
}

function expectSources(detection: EvalDetection) {
	expect(detection.unavailable).toEqual([]);
	return detection.sources;
}

describe("detectEvalSources", () => {
	it("detects python -c inline source", () => {
		const sources = expectSources(
			detectEvalSources(
				stage([arg("python3"), arg("-c"), arg("print(1)")], []),
			),
		);
		expect(sources).toEqual([
			{
				language: "python",
				source: "print(1)",
				interpreter: "python3",
				origin: "inline",
			},
		]);
	});

	it("matches versioned python executables", () => {
		const sources = expectSources(
			detectEvalSources(stage([arg("python3.11"), arg("-c"), arg("x")], [])),
		);
		expect(sources[0].interpreter).toBe("python3.11");
		expect(sources[0].language).toBe("python");
	});

	it("skips python script files and module runs", () => {
		expect(
			detectEvalSources(stage([arg("python3"), arg("script.py")], [])),
		).toEqual({ sources: [], unavailable: [] });
		expect(
			detectEvalSources(stage([arg("python3"), arg("-m"), arg("pytest")], [])),
		).toEqual({ sources: [], unavailable: [] });
	});

	it("reports dynamic python -c source as unavailable", () => {
		const detection = detectEvalSources(
			stage([arg("python3"), arg("-c"), arg("$CODE", false)], []),
		);
		expect(detection.sources).toEqual([]);
		expect(detection.unavailable).toEqual([
			"python3 evaluation source is dynamic",
		]);
	});

	it("detects python stdin heredocs and reports missing stdin as unavailable", () => {
		const withHeredoc = expectSources(
			detectEvalSources(
				stage([arg("python3"), arg("-")], [heredoc("print(1)\n")]),
			),
		);
		expect(withHeredoc[0]).toMatchObject({
			language: "python",
			origin: "heredoc",
		});

		const piped = detectEvalSources(stage([arg("python3"), arg("-")], []));
		expect(piped.sources).toEqual([]);
		expect(piped.unavailable).toHaveLength(1);
	});

	it("skips bare python with no stdin source", () => {
		expect(detectEvalSources(stage([arg("python3")], []))).toEqual({
			sources: [],
			unavailable: [],
		});
	});

	it("detects node -e and --eval= forms, skips script files", () => {
		const inline = expectSources(
			detectEvalSources(stage([arg("node"), arg("-e"), arg("1+1")], [])),
		);
		expect(inline[0]).toMatchObject({
			language: "javascript",
			origin: "inline",
		});
		const equals = expectSources(
			detectEvalSources(stage([arg("node"), arg("--eval=1+1")], [])),
		);
		expect(equals[0].source).toBe("1+1");
		expect(
			detectEvalSources(stage([arg("node"), arg("server.js")], [])),
		).toEqual({ sources: [], unavailable: [] });
	});

	it("detects bun -e as typescript", () => {
		const sources = expectSources(
			detectEvalSources(stage([arg("bun"), arg("-e"), arg("1+1")], [])),
		);
		expect(sources[0].language).toBe("typescript");
	});

	it("detects deno eval, skips other subcommands", () => {
		const sources = expectSources(
			detectEvalSources(stage([arg("deno"), arg("eval"), arg("1+1")], [])),
		);
		expect(sources).toEqual([
			{
				language: "typescript",
				source: "1+1",
				interpreter: "deno",
				origin: "inline",
			},
		]);
		expect(
			detectEvalSources(stage([arg("deno"), arg("run"), arg("main.ts")], [])),
		).toEqual({ sources: [], unavailable: [] });
		expect(
			detectEvalSources(stage([arg("deno"), arg("eval")], [])).unavailable,
		).toHaveLength(1);
	});

	it("detects tsx -e, skips tsx script files", () => {
		const sources = expectSources(
			detectEvalSources(stage([arg("tsx"), arg("-e"), arg("1+1")], [])),
		);
		expect(sources[0].language).toBe("typescript");
		expect(
			detectEvalSources(stage([arg("tsx"), arg("script.ts")], [])),
		).toEqual({ sources: [], unavailable: [] });
	});

	it("detects bash -c and shell stdin heredocs, skips script files", () => {
		const inline = expectSources(
			detectEvalSources(stage([arg("bash"), arg("-c"), arg("rm -rf x")], [])),
		);
		expect(inline).toEqual([
			{
				language: "shell",
				source: "rm -rf x",
				interpreter: "bash",
				origin: "inline",
			},
		]);
		const heredocSources = expectSources(
			detectEvalSources(stage([arg("sh")], [heredoc("echo hi\n")])),
		);
		expect(heredocSources[0]).toMatchObject({
			language: "shell",
			origin: "heredoc",
		});
		expect(
			detectEvalSources(stage([arg("bash"), arg("deploy.sh")], [])),
		).toEqual({ sources: [], unavailable: [] });
	});

	it("unwraps env wrappers and skips bare env", () => {
		const sources = expectSources(
			detectEvalSources(
				stage(
					[arg("env"), arg("FOO=1"), arg("python3"), arg("-c"), arg("x")],
					[],
				),
			),
		);
		expect(sources[0]).toMatchObject({
			language: "python",
			interpreter: "python3",
		});
		expect(detectEvalSources(stage([arg("env")], []))).toEqual({
			sources: [],
			unavailable: [],
		});
	});

	it("ignores non-interpreter commands", () => {
		expect(detectEvalSources(stage([arg("git"), arg("commit")], []))).toEqual({
			sources: [],
			unavailable: [],
		});
		expect(detectEvalSources(stage([], []))).toEqual({
			sources: [],
			unavailable: [],
		});
	});
});
