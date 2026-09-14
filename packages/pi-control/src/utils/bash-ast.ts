/**
 * Bash command parsing via Tree-sitter's Bash grammar.
 *
 * Extracts, per command stage:
 *   - The reconstructed command string used for rule matching
 *   - Static command arguments
 *   - File paths from redirect targets (skips fd-to-fd/numeric-fd redirects)
 *   - Path-like non-flag arguments
 *   - Static source supplied through heredocs and here-strings
 *
 * Falls back to a simple tokenizer when Tree-sitter is unavailable or parsing
 * cannot identify a command. Fallback results are explicitly marked incomplete
 * so interpreter analysis cannot mistake them for fully understood input.
 */

import type {
	Node as SyntaxNode,
	Parser as TreeSitterParser,
} from "@vscode/tree-sitter-wasm";
import { createTreeSitterParser } from "./tree-sitter.js";

export interface CommandArgument {
	/** Shell-decoded value when it can be determined statically. */
	value: string;
	/** False when the argument contains expansion or substitution. */
	static: boolean;
}

export interface EmbeddedSource {
	kind: "heredoc" | "herestring";
	text: string;
	static: boolean;
}

export interface CommandStage {
	/** Reconstructed command string for pattern matching. */
	command: string;
	/** Structured command arguments, including argv[0]. */
	args: CommandArgument[];
	/** File paths from redirect targets (e.g. `> /tmp/out.txt`). */
	redirectFiles: string[];
	/** Path-like non-flag arguments (e.g. `~`, `/tmp/foo`, `./bar`). */
	pathArgs: string[];
	/** Source supplied directly to the command's standard input. */
	embeddedSources: EmbeddedSource[];
	/** True when parsing or static shell-word decoding was incomplete. */
	analysisIncomplete: boolean;
}

// ─── Module state ────────────────────────────────────────────────────────────

let parser: TreeSitterParser | null = null;
let parserUnavailable = false;
let initialization: Promise<void> | null = null;

export async function initBashParser(
	onWarning: (msg: string) => void,
): Promise<void> {
	if (parser || parserUnavailable) return;
	if (initialization) return initialization;

	initialization = (async () => {
		try {
			const nextParser = await createTreeSitterParser("bash");
			// Smoke-test both the runtime and grammar before publishing the parser.
			const tree = nextParser.parse("echo test");
			if (!tree) throw new Error("Tree-sitter returned no syntax tree");
			tree.delete();
			parser = nextParser;
		} catch (err) {
			parserUnavailable = true;
			onWarning(
				`[pi-controls] Tree-sitter Bash parser failed to load (${err}). ` +
					"Falling back to incomplete token analysis for Bash commands.",
			);
		}
	})();

	return initialization;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true for tokens that are likely filesystem paths rather than flags or bare words. */
function isPathLike(token: string): boolean {
	return (
		token === "~" ||
		token.startsWith("~/") ||
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../")
	);
}

function commandBasename(command: string): string {
	return command.split("/").at(-1) ?? command;
}

/**
 * Extract path operands while excluding syntax that happens to start with `/`.
 * In particular, a sed program such as `/pattern/,/^}$/p` is a regex range,
 * not an absolute filesystem path. `-f` remains a real sed script file and is
 * therefore kept as a path target when path-like.
 */
function pathArgsForCommand(args: CommandArgument[]): string[] {
	if (args.length === 0 || !args[0].static) return [];
	if (commandBasename(args[0].value) !== "sed") {
		return args
			.slice(1)
			.filter((argument) => argument.static && isPathLike(argument.value))
			.map((argument) => argument.value);
	}

	const paths: string[] = [];
	let programSeen = false;
	let optionsEnded = false;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (!argument.static) continue;
		const value = argument.value;

		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && (value === "-e" || value === "--expression")) {
			programSeen = true;
			index++;
			continue;
		}
		if (!optionsEnded && (value === "-f" || value === "--file")) {
			const file = args[++index];
			if (file?.static && isPathLike(file.value)) paths.push(file.value);
			programSeen = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("--expression=")) {
			programSeen = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("--file=")) {
			const file = value.slice("--file=".length);
			if (isPathLike(file)) paths.push(file);
			programSeen = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-e") && value.length > 2) {
			programSeen = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-f") && value.length > 2) {
			const file = value.slice(2);
			if (isPathLike(file)) paths.push(file);
			programSeen = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-")) continue;

		if (!programSeen) {
			programSeen = true;
			continue;
		}
		if (isPathLike(value)) paths.push(value);
	}
	return paths;
}

const DYNAMIC_SHELL_NODES = new Set([
	"arithmetic_expansion",
	"brace_expansion",
	"command_substitution",
	"process_substitution",
	"simple_expansion",
	"special_variable_name",
	"variable_expansion",
]);

function namedChildren(node: SyntaxNode): SyntaxNode[] {
	return node.namedChildren.filter(
		(child): child is SyntaxNode => child !== null,
	);
}

function containsDynamicShellNode(node: SyntaxNode): boolean {
	if (DYNAMIC_SHELL_NODES.has(node.type)) return true;
	return namedChildren(node).some(containsDynamicShellNode);
}

/** Decode static shell quoting without performing expansion. */
function decodeStaticShellWord(text: string): string | null {
	let result = "";
	let quote: "single" | "double" | null = null;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quote === "single") {
			if (char === "'") quote = null;
			else result += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') {
				quote = null;
			} else if (char === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					result += next;
					i++;
				} else {
					result += char;
				}
			} else {
				result += char;
			}
			continue;
		}

		if (char === "'") quote = "single";
		else if (char === '"') quote = "double";
		else if (char === "\\" && i + 1 < text.length) result += text[++i];
		else result += char;
	}

	return quote === null ? result : null;
}

function argumentFromNode(node: SyntaxNode): CommandArgument {
	if (containsDynamicShellNode(node)) {
		return { value: node.text, static: false };
	}
	const decoded = decodeStaticShellWord(node.text);
	return decoded === null
		? { value: node.text, static: false }
		: { value: decoded, static: true };
}

function commandArguments(node: SyntaxNode): CommandArgument[] {
	const result: CommandArgument[] = [];
	const name = node.childForFieldName("name");
	if (name) result.push(argumentFromNode(name));
	for (const argument of node.childrenForFieldName("argument")) {
		if (argument) result.push(argumentFromNode(argument));
	}
	return result;
}

function tokenizeStaticWords(fragment: string): CommandArgument[] {
	const tokenRe = /"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g;
	const args: CommandArgument[] = [];
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(fragment)) !== null) {
		const value = decodeStaticShellWord(match[0]);
		args.push(
			value === null
				? { value: match[0], static: false }
				: { value, static: true },
		);
	}
	return args;
}

function redirectNodes(node: SyntaxNode): SyntaxNode[] {
	return node
		.childrenForFieldName("redirect")
		.filter((child) => child !== null);
}

function extractRedirects(redirects: SyntaxNode[]): Pick<
	CommandStage,
	"redirectFiles" | "embeddedSources"
> & {
	incomplete: boolean;
} {
	const redirectFiles: string[] = [];
	const embeddedSources: EmbeddedSource[] = [];
	let incomplete = false;

	for (const redirect of redirects) {
		switch (redirect.type) {
			case "file_redirect": {
				// Preserve existing behavior: redirects with an explicit numeric file
				// descriptor (2>/dev/null, 2>&1) are not policy targets.
				if (redirect.childForFieldName("descriptor")) break;
				const destination = redirect.childForFieldName("destination");
				if (!destination) {
					incomplete = true;
					break;
				}
				const argument = argumentFromNode(destination);
				if (argument.static) redirectFiles.push(argument.value);
				else incomplete = true;
				break;
			}
			case "heredoc_redirect": {
				const body = namedChildren(redirect).find(
					(child) => child.type === "heredoc_body",
				);
				if (body) {
					embeddedSources.push({
						kind: "heredoc",
						text: body.text,
						static: !containsDynamicShellNode(body),
					});
				} else {
					incomplete = true;
				}
				// A pipeline embedded in the redirect node means the heredoc is
				// connected to another stage indirectly. Preserve the source on its
				// direct command but mark the overall analysis incomplete.
				if (
					namedChildren(redirect).some(
						(child) => child.type === "pipeline" || child.type === "command",
					)
				) {
					incomplete = true;
				}
				break;
			}
			case "herestring_redirect": {
				const source = namedChildren(redirect).at(-1);
				if (!source) {
					incomplete = true;
					break;
				}
				const argument = argumentFromNode(source);
				embeddedSources.push({
					kind: "herestring",
					text: argument.value,
					static: argument.static,
				});
				if (!argument.static) incomplete = true;
				break;
			}
		}
	}

	return { redirectFiles, embeddedSources, incomplete };
}

function buildStage(
	node: SyntaxNode,
	inheritedRedirects: SyntaxNode[],
	rootHasError: boolean,
): CommandStage {
	const ownRedirects = redirectNodes(node);
	const redirects = [...ownRedirects, ...inheritedRedirects];
	const args = commandArguments(node);

	// The Bash grammar currently omits a bare `-` immediately before a heredoc
	// redirect from the command node. Recover static words from that source gap.
	if (inheritedRedirects.length > 0) {
		const firstRedirect = [...inheritedRedirects].sort(
			(a, b) => a.startIndex - b.startIndex,
		)[0];
		if (firstRedirect && firstRedirect.startIndex > node.endIndex) {
			args.push(
				...tokenizeStaticWords(
					node.tree.rootNode.text.slice(
						node.endIndex,
						firstRedirect.startIndex,
					),
				),
			);
		}
	}

	const extracted = extractRedirects(redirects);
	const pathArgs = pathArgsForCommand(args);

	return {
		command: args.map((argument) => argument.value).join(" "),
		args,
		redirectFiles: extracted.redirectFiles,
		pathArgs,
		embeddedSources: extracted.embeddedSources,
		analysisIncomplete:
			rootHasError ||
			extracted.incomplete ||
			args.some((argument) => !argument.static),
	};
}

function collectStages(
	node: SyntaxNode,
	stages: CommandStage[],
	rootHasError: boolean,
	inheritedRedirects: SyntaxNode[] = [],
): void {
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const redirects = redirectNodes(node);
		if (body) collectStages(body, stages, rootHasError, redirects);
		return;
	}

	if (node.type === "command") {
		stages.push(buildStage(node, inheritedRedirects, rootHasError));
		// Commands nested in substitutions execute as separate stages.
		for (const child of namedChildren(node)) {
			if (
				child.type === "command_substitution" ||
				child.type === "process_substitution"
			) {
				collectStages(child, stages, rootHasError);
			}
		}
		return;
	}

	for (const child of namedChildren(node)) {
		collectStages(child, stages, rootHasError, inheritedRedirects);
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseCommand(command: string): Promise<CommandStage[]> {
	if (!parserUnavailable && parser) {
		try {
			const tree = parser.parse(command);
			if (tree) {
				try {
					const stages: CommandStage[] = [];
					collectStages(tree.rootNode, stages, tree.rootNode.hasError);
					if (stages.length > 0) return stages;
				} finally {
					tree.delete();
				}
			}
		} catch {
			// Fall through to the explicitly incomplete tokenizer fallback.
		}
	}
	return regexFallback(command);
}

function regexFallback(command: string): CommandStage[] {
	const args = tokenizeStaticWords(command);
	const pathArgs = pathArgsForCommand(args);
	return [
		{
			command,
			args,
			redirectFiles: [],
			pathArgs,
			embeddedSources: [],
			analysisIncomplete: true,
		},
	];
}
