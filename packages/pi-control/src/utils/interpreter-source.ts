import { basename } from "node:path";
import type {
	CommandArgument,
	CommandStage,
	EmbeddedSource,
} from "./bash-ast.js";

export type EmbeddedLanguage = "javascript" | "python" | "shell" | "typescript";

export interface InterpreterSource {
	language: EmbeddedLanguage;
	source: string;
	interpreter: string;
	origin: "heredoc" | "herestring" | "inline";
}

export interface InterpreterExtraction {
	sources: InterpreterSource[];
	unresolvedEffects: string[];
}

export interface InterpreterExtractionOptions {
	maxSourceBytes?: number;
}

const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PYTHON_EXECUTABLE = /^python(?:w)?(?:\d+(?:\.\d+)*)?$/;

function executableName(argument: CommandArgument): string | null {
	if (!argument.static) return null;
	return basename(argument.value).toLowerCase();
}

function unwrapEnv(args: CommandArgument[]): {
	args: CommandArgument[];
	unresolved?: string;
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
		return { args: [], unresolved: "env wrapper has no command" };
	}
	return { args: args.slice(index) };
}

function sourceFromStdin(
	stage: CommandStage,
	language: EmbeddedLanguage,
	interpreter: string,
): InterpreterSource[] {
	return stage.embeddedSources
		.filter((source): source is EmbeddedSource => source.static)
		.map((source) => ({
			language,
			source: source.text,
			interpreter,
			origin: source.kind,
		}));
}

function sourceAfterFlag(
	args: CommandArgument[],
	flagIndex: number,
	language: EmbeddedLanguage,
	interpreter: string,
): InterpreterSource | string {
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

function standardInputResult(
	stage: CommandStage,
	language: EmbeddedLanguage,
	interpreter: string,
): InterpreterExtraction {
	const sources = sourceFromStdin(stage, language, interpreter);
	return sources.length > 0
		? { sources, unresolvedEffects: [] }
		: {
				sources: [],
				unresolvedEffects: [
					`${interpreter} standard-input source is not statically available`,
				],
			};
}

function javaScriptInlineResult(
	args: CommandArgument[],
	source: InterpreterSource | string,
	trailingStart: number,
	interpreter: "bun" | "node",
): InterpreterExtraction {
	if (typeof source === "string") {
		return { sources: [], unresolvedEffects: [source] };
	}
	for (let index = trailingStart; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} invocation contains a dynamic argument`,
				],
			};
		}
		// Node accepts runtime options after -e/--eval. Treat every trailing flag
		// as unresolved rather than assuming it is only an argument to the source.
		if (argument.value.startsWith("-")) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} uses unsupported execution options after inline source`,
				],
			};
		}
	}
	return { sources: [source], unresolvedEffects: [] };
}

function extractPython(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: string,
): InterpreterExtraction {
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} invocation contains a dynamic argument`,
				],
			};
		}
		if (argument.value === "-c") {
			const source = sourceAfterFlag(args, index, "python", interpreter);
			return typeof source === "string"
				? { sources: [], unresolvedEffects: [source] }
				: { sources: [source], unresolvedEffects: [] };
		}
		if (argument.value === "-")
			return standardInputResult(stage, "python", interpreter);
		if (argument.value === "-m" || argument.value.startsWith("-m")) {
			return {
				sources: [],
				unresolvedEffects: [`${interpreter} module execution is not analyzed`],
			};
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			return {
				sources: [],
				unresolvedEffects: [`${interpreter} script files are not yet analyzed`],
			};
		}
		if (!PYTHON_SAFE_OPTIONS.has(argument.value)) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} uses unsupported execution options`,
				],
			};
		}
	}

	const stdinSources = sourceFromStdin(stage, "python", interpreter);
	return { sources: stdinSources, unresolvedEffects: [] };
}

function extractJavaScriptRuntime(
	args: CommandArgument[],
	stage: CommandStage,
	interpreter: "bun" | "node",
): InterpreterExtraction {
	const language: EmbeddedLanguage =
		interpreter === "bun" ? "typescript" : "javascript";
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} invocation contains a dynamic argument`,
				],
			};
		}
		if (["-e", "--eval", "-p", "--print"].includes(argument.value)) {
			return javaScriptInlineResult(
				args,
				sourceAfterFlag(args, index, language, interpreter),
				index + 2,
				interpreter,
			);
		}
		for (const prefix of ["--eval=", "--print="]) {
			if (argument.value.startsWith(prefix)) {
				return javaScriptInlineResult(
					args,
					{
						language,
						source: argument.value.slice(prefix.length),
						interpreter,
						origin: "inline",
					},
					index + 1,
					interpreter,
				);
			}
		}
		if (argument.value === "-")
			return standardInputResult(stage, language, interpreter);
		if (!argument.value.startsWith("-") || argument.value === "--") {
			return {
				sources: [],
				unresolvedEffects: [`${interpreter} script files are not yet analyzed`],
			};
		}
		if (!JS_SAFE_OPTIONS.has(argument.value)) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} uses unsupported execution options`,
				],
			};
		}
	}

	const stdinSources = sourceFromStdin(stage, language, interpreter);
	return { sources: stdinSources, unresolvedEffects: [] };
}

function extractShell(
	args: CommandArgument[],
	interpreter: "bash" | "sh",
): InterpreterExtraction {
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} invocation contains a dynamic argument`,
				],
			};
		}
		if (argument.value === "-c") {
			const source = sourceAfterFlag(args, index, "shell", interpreter);
			return typeof source === "string"
				? { sources: [], unresolvedEffects: [source] }
				: { sources: [source], unresolvedEffects: [] };
		}
		if (argument.value === "-s" || argument.value === "-") {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} standard-input source is not statically available`,
				],
			};
		}
		if (!argument.value.startsWith("-") || argument.value === "--") {
			return {
				sources: [],
				unresolvedEffects: [`${interpreter} script files are not yet analyzed`],
			};
		}
		if (!SHELL_SAFE_OPTIONS.has(argument.value)) {
			return {
				sources: [],
				unresolvedEffects: [
					`${interpreter} uses unsupported execution options`,
				],
			};
		}
	}
	return { sources: [], unresolvedEffects: [] };
}

/** Extract statically supplied source from a parsed Bash command stage. */
export function extractInterpreterSources(
	stage: CommandStage,
	options: InterpreterExtractionOptions = {},
): InterpreterExtraction {
	const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
	if (stage.args.length === 0) return { sources: [], unresolvedEffects: [] };

	const unwrapped = unwrapEnv(stage.args);
	if (unwrapped.unresolved) {
		return { sources: [], unresolvedEffects: [unwrapped.unresolved] };
	}
	const args = unwrapped.args;
	const interpreter = executableName(args[0]);
	if (!interpreter) {
		return stage.analysisIncomplete
			? { sources: [], unresolvedEffects: [] }
			: { sources: [], unresolvedEffects: [] };
	}

	let result: InterpreterExtraction;
	if (PYTHON_EXECUTABLE.test(interpreter)) {
		result = extractPython(args, stage, interpreter);
	} else if (interpreter === "node" || interpreter === "bun") {
		result = extractJavaScriptRuntime(args, stage, interpreter);
	} else if (interpreter === "bash" || interpreter === "sh") {
		result = extractShell(args, interpreter);
	} else {
		return { sources: [], unresolvedEffects: [] };
	}

	if (stage.analysisIncomplete) {
		result.unresolvedEffects.push(
			`${interpreter} shell invocation could not be analyzed completely`,
		);
	}
	for (const source of result.sources) {
		if (Buffer.byteLength(source.source, "utf8") > maxSourceBytes) {
			result.unresolvedEffects.push(
				`${interpreter} source exceeds the ${maxSourceBytes}-byte analysis limit`,
			);
		}
	}
	if (result.unresolvedEffects.length > 0) {
		result.sources = result.sources.filter(
			(source) => Buffer.byteLength(source.source, "utf8") <= maxSourceBytes,
		);
	}
	return result;
}
