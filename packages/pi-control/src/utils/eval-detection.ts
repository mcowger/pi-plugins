/**
 * Detection of inline code evals in parsed Bash stages.
 *
 * Identifies when a stage executes source code supplied inline (evaluation
 * flags such as `python -c`, `node -e`, `bash -c`) or through standard input
 * (heredocs / here-strings attached to an interpreter expecting code).
 * Script-file and module runs (`python script.py`, `python -m pytest`) carry
 * no inline source and are left to path-based policy — they are skipped, not
 * reported.
 *
 * Detection only: returned sources are classified by the Decisions API (see
 * ./decisions.ts). Eval-shaped invocations whose source cannot be recovered
 * statically (dynamic arguments, piped stdin, unsupported options) are
 * reported in `unavailable` for the caller to handle via policy.
 */

import { basename } from "node:path";
import type {
	CommandArgument,
	CommandStage,
	EmbeddedSource,
} from "./bash-ast.js";

export type EvalLanguage = "python" | "javascript" | "typescript" | "shell";
export type EvalOrigin = "inline" | "heredoc" | "herestring";

export interface EvalSource {
	language: EvalLanguage;
	source: string;
	interpreter: string;
	origin: EvalOrigin;
}

export interface EvalDetection {
	sources: EvalSource[];
	unavailable: string[];
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PYTHON_EXECUTABLE = /^python(?:w)?(?:\d+(?:\.\d+)*)?$/;

const PYTHON_SAFE_OPTIONS = new Set([
	"-B",
	"-d",
	"-E",
	"-i",
	"-I",
	"-O",
	"-OO",
	"-q",
	"-s",
	"-S",
	"-u",
	"-v",
	"-V",
	"-VV",
	"-x",
	"--help",
	"--version",
	"--verbose",
	"--quiet",
	"--isolated",
	"--ignore-environment",
	"--no-site",
	"--no-user-site",
]);
const JS_SAFE_OPTIONS = new Set(["-v", "--version", "-h", "--help"]);
const SHELL_SAFE_OPTIONS = new Set(["-e", "-f", "-n", "-u", "-v", "-x"]);
const DENO_EVAL_OPTIONS = new Set(["-p", "--print"]);

function executableName(argument: CommandArgument): string | null {
	if (!argument.static) return null;
	return basename(argument.value).toLowerCase();
}

function none(): EvalDetection {
	return { sources: [], unavailable: [] };
}

function unrecoverable(reason: string): EvalDetection {
	return { sources: [], unavailable: [reason] };
}

function unwrapEnv(args: CommandArgument[]): {
	args: CommandArgument[];
	unresolved?: string;
	/** `env` with no command only prints the environment — nothing to judge. */
	noCommand?: boolean;
} {
	if (executableName(args[0]) !== "env") return { args };

	let index = 1;
	while (index < args.length) {
		const argument = args[index];
		if (!argument.static) {
			return {
				args: [],
				unresolved: "env wrapper contains a dynamic argument",
			};
		}
		const value = argument.value;
		if (value === "--") {
			index++;
			break;
		}
		if (ENV_ASSIGNMENT.test(value)) {
			index++;
			continue;
		}
		if (value === "-u" || value === "--unset") {
			if (!args[index + 1]?.static) {
				return {
					args: [],
					unresolved: `env ${value} has a missing or dynamic value`,
				};
			}
			index += 2;
			continue;
		}
		if (value === "-C" || value === "--chdir" || value.startsWith("--chdir=")) {
			return {
				args: [],
				unresolved: "env changes the command working directory",
			};
		}
		if (
			value === "-i" ||
			value === "--ignore-environment" ||
			value.startsWith("--unset=")
		) {
			index++;
			continue;
		}
		if (value.startsWith("-")) {
			return {
				args: [],
				unresolved: `unsupported env wrapper option: ${value}`,
			};
		}
		break;
	}

	if (index >= args.length) {
		return {
			args: [],
			unresolved: "env wrapper has no command",
			noCommand: true,
		};
	}
	return { args: args.slice(index) };
}

/** Static stdin sources (heredocs / here-strings) as eval sources. */
function stdinSources(
	stage: CommandStage,
	language: EvalLanguage,
	interpreter: string,
): EvalSource[] {
	return stage.embeddedSources
		.filter((source): source is EmbeddedSource & { static: true } =>
			Boolean(source.static),
		)
		.map((source) => ({
			language,
			source: source.text,
			interpreter,
			origin: source.kind,
		}));
}

/**
 * Stdin-as-code was explicitly requested (`-` / `-s`) or is the only way the
 * interpreter could receive code. Static heredocs classify; anything else
 * (piped input, dynamic heredocs) is unrecoverable.
 */
function stdinResult(
	stage: CommandStage,
	language: EvalLanguage,
	interpreter: string,
): EvalDetection {
	const sources = stdinSources(stage, language, interpreter);
	return sources.length > 0
		? { sources, unavailable: [] }
		: unrecoverable(
				`${interpreter} standard-input source is not statically available`,
			);
}

function inlineSource(
	args: CommandArgument[],
	flagIndex: number,
	language: EvalLanguage,
	interpreter: string,
): EvalSource | string {
	const source = args[flagIndex + 1];
	if (!source) return `${interpreter} evaluation flag has no source argument`;
	if (!source.static) return `${interpreter} evaluation source is dynamic`;
	return {
		language,
		source: source.value,
		interpreter,
		origin: "inline",
	};
}

function inlineResult(
	args: CommandArgument[],
	flagIndex: number,
	language: EvalLanguage,
	interpreter: string,
): EvalDetection {
	const source = inlineSource(args, flagIndex, language, interpreter);
	return typeof source === "string"
		? unrecoverable(source)
		: { sources: [source], unavailable: [] };
}

function extractPython(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: string,
): EvalDetection {
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return unrecoverable(
				`${interpreter} invocation contains a dynamic argument`,
			);
		}
		if (argument.value === "-c") {
			return inlineResult(args, index, "python", interpreter);
		}
		if (argument.value === "-") {
			return stdinResult(stage, "python", interpreter);
		}
		if (argument.value === "-m" || argument.value.startsWith("-m")) {
			// Module execution — no inline source, left to path-based policy.
			return none();
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			// Script file — no inline source, left to path-based policy.
			return none();
		}
		if (!PYTHON_SAFE_OPTIONS.has(argument.value)) {
			return unrecoverable(`${interpreter} uses unsupported execution options`);
		}
	}
	// Bare `python3`: code can only arrive via stdin redirect.
	const sources = stdinSources(stage, "python", interpreter);
	return { sources, unavailable: [] };
}

function extractJavaScriptRuntime(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: "bun" | "node",
): EvalDetection {
	const language: EvalLanguage =
		interpreter === "bun" ? "typescript" : "javascript";
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return unrecoverable(
				`${interpreter} invocation contains a dynamic argument`,
			);
		}
		if (["-e", "--eval", "-p", "--print"].includes(argument.value)) {
			return inlineResult(args, index, language, interpreter);
		}
		for (const prefix of ["--eval=", "--print="]) {
			if (argument.value.startsWith(prefix)) {
				return {
					sources: [
						{
							language,
							source: argument.value.slice(prefix.length),
							interpreter,
							origin: "inline",
						},
					],
					unavailable: [],
				};
			}
		}
		if (argument.value === "-") {
			return stdinResult(stage, language, interpreter);
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			// Script file — no inline source, left to path-based policy.
			return none();
		}
		if (!JS_SAFE_OPTIONS.has(argument.value)) {
			return unrecoverable(`${interpreter} uses unsupported execution options`);
		}
	}
	// Bare `node` / `bun`: code can only arrive via stdin redirect.
	const sources = stdinSources(stage, language, interpreter);
	return { sources, unavailable: [] };
}

function extractDeno(
	args: CommandArgument[],
	stage: CommandStage,
): EvalDetection {
	const subcommand = args[1];
	if (!subcommand) {
		// Bare `deno`: code can only arrive via stdin redirect.
		const sources = stdinSources(stage, "typescript", "deno");
		return { sources, unavailable: [] };
	}
	if (!subcommand.static) {
		return unrecoverable("deno invocation contains a dynamic argument");
	}
	if (subcommand.value !== "eval") {
		// run / test / fmt / … — no inline source, left to path-based policy.
		return none();
	}
	for (let index = 2; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return unrecoverable("deno eval source is dynamic");
		}
		if (
			DENO_EVAL_OPTIONS.has(argument.value) ||
			argument.value.startsWith("--ext=")
		) {
			continue;
		}
		if (argument.value.startsWith("-")) {
			return unrecoverable("deno eval uses unsupported execution options");
		}
		// First non-flag operand is the code; the rest is its argv.
		// (argument is static here — dynamic args return above.)
		return {
			sources: [
				{
					language: "typescript",
					source: argument.value,
					interpreter: "deno",
					origin: "inline",
				},
			],
			unavailable: [],
		};
	}
	return unrecoverable("deno eval has no source argument");
}

function extractTypeScriptRunner(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: "tsx" | "ts-node",
): EvalDetection {
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return unrecoverable(
				`${interpreter} invocation contains a dynamic argument`,
			);
		}
		if (argument.value === "-e" || argument.value === "--eval") {
			return inlineResult(args, index, "typescript", interpreter);
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			// Script file — no inline source, left to path-based policy.
			return none();
		}
		// tsx/ts-node accept many passthrough flags (--tsconfig, …). Any flag
		// before the code is treated as unrecoverable rather than assumed safe.
		return unrecoverable(`${interpreter} uses unsupported execution options`);
	}
	// Bare runner: code can only arrive via stdin redirect.
	const sources = stdinSources(stage, "typescript", interpreter);
	return { sources, unavailable: [] };
}

function extractShell(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: "bash" | "sh",
): EvalDetection {
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return unrecoverable(
				`${interpreter} invocation contains a dynamic argument`,
			);
		}
		if (argument.value === "-c") {
			return inlineResult(args, index, "shell", interpreter);
		}
		if (argument.value === "-s" || argument.value === "-") {
			return stdinResult(stage, "shell", interpreter);
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			// Script file — no inline source, left to path-based policy.
			return none();
		}
		if (!SHELL_SAFE_OPTIONS.has(argument.value)) {
			return unrecoverable(`${interpreter} uses unsupported execution options`);
		}
	}
	// Bare `bash` / `sh`: code can only arrive via stdin redirect.
	const sources = stdinSources(stage, "shell", interpreter);
	return { sources, unavailable: [] };
}

/** Detect inline code evals in a parsed Bash command stage. */
export function detectEvalSources(stage: CommandStage): EvalDetection {
	if (stage.args.length === 0) return none();

	const unwrapped = unwrapEnv(stage.args);
	if (unwrapped.unresolved) {
		if (unwrapped.noCommand) return none();
		return unrecoverable(unwrapped.unresolved);
	}
	const args = unwrapped.args;
	const interpreter = executableName(args[0]);
	if (!interpreter) {
		return unrecoverable("interpreter name is dynamic");
	}

	if (PYTHON_EXECUTABLE.test(interpreter)) {
		return extractPython(args, stage, interpreter);
	}
	if (interpreter === "node" || interpreter === "bun") {
		return extractJavaScriptRuntime(args, stage, interpreter);
	}
	if (interpreter === "deno") {
		return extractDeno(args, stage);
	}
	if (interpreter === "tsx" || interpreter === "ts-node") {
		return extractTypeScriptRunner(args, stage, interpreter);
	}
	if (interpreter === "bash" || interpreter === "sh") {
		return extractShell(args, stage, interpreter);
	}
	return none();
}
