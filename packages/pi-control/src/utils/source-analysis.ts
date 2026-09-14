import { join, resolve } from "node:path";
import type { Node as SyntaxNode, Parser } from "@vscode/tree-sitter-wasm";
import type { EmbeddedLanguage } from "./interpreter-source.js";
import { createTreeSitterParser } from "./tree-sitter.js";

export interface SourceFinding {
	capability: "execute" | "read" | "write";
	path: string | null;
	evidence: string;
}

export interface SourceAnalysis {
	findings: SourceFinding[];
	unresolvedEffects: string[];
	parseErrors: string[];
}

export interface SourceAnalysisOptions {
	cwd: string;
	maxNodes?: number;
}

const DEFAULT_MAX_NODES = 10_000;
const parserPromises = new Map<string, Promise<Parser>>();

function getParser(language: "javascript" | "python" | "typescript") {
	let parserPromise = parserPromises.get(language);
	if (!parserPromise) {
		parserPromise = createTreeSitterParser(language);
		parserPromises.set(language, parserPromise);
	}
	return parserPromise;
}

function children(node: SyntaxNode): SyntaxNode[] {
	return node.namedChildren.filter(
		(child): child is SyntaxNode => child !== null,
	);
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of children(node)) walk(child, visit);
}

function countNodes(root: SyntaxNode, limit: number): number {
	let count = 0;
	walk(root, () => {
		count++;
		if (count > limit) throw new Error("node-limit");
	});
	return count;
}

function decodeEscapes(value: string): string {
	return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, code) => {
		if (code.startsWith("x"))
			return String.fromCharCode(Number.parseInt(code.slice(1), 16));
		if (code.startsWith("u"))
			return String.fromCharCode(Number.parseInt(code.slice(1), 16));
		const escapes: Record<string, string> = {
			n: "\n",
			r: "\r",
			t: "\t",
			b: "\b",
			f: "\f",
			v: "\v",
			"0": "\0",
			"\\": "\\",
			"'": "'",
			'"': '"',
		};
		return escapes[code] ?? code;
	});
}

function stringLiteral(node: SyntaxNode): string | null {
	if (node.type === "concatenated_string") {
		const parts = children(node).map(stringLiteral);
		return parts.every((part) => part !== null) ? parts.join("") : null;
	}
	if (node.type === "template_string") {
		if (children(node).some((child) => child.type === "template_substitution"))
			return null;
		return children(node)
			.filter((child) => child.type === "string_fragment")
			.map((child) => child.text)
			.join("");
	}
	if (node.type !== "string") return null;
	if (
		children(node).some((child) =>
			["interpolation", "template_substitution"].includes(child.type),
		)
	) {
		return null;
	}
	const text = node.text;
	const prefixMatch = text.match(/^([rRuUbBfF]*)(["']{1,3})/);
	if (!prefixMatch) return null;
	const [, prefix, quote] = prefixMatch;
	if (prefix.toLowerCase().includes("f")) return null;
	if (!text.endsWith(quote)) return null;
	const body = text.slice(prefix.length + quote.length, -quote.length);
	return prefix.toLowerCase().includes("r") ? body : decodeEscapes(body);
}

function argumentNodes(node: SyntaxNode): SyntaxNode[] {
	const args = node.childForFieldName("arguments");
	return args ? children(args) : [];
}

function pythonArgument(
	args: SyntaxNode[],
	position: number,
	keyword: string,
): SyntaxNode | null {
	const keywordArgument = args.find(
		(argument) =>
			argument.type === "keyword_argument" &&
			argument.childForFieldName("name")?.text === keyword,
	);
	if (keywordArgument) return keywordArgument.childForFieldName("value");
	return (
		args.filter((argument) => argument.type !== "keyword_argument")[position] ??
		null
	);
}

interface ValueContext {
	constants: Map<string, string>;
	modules: Map<string, string>;
	pathConstructors: Set<string>;
	cwd: string;
}

function callName(node: SyntaxNode, context: ValueContext): string | null {
	if (node.type === "identifier") return node.text;
	if (node.type !== "attribute" && node.type !== "member_expression")
		return null;
	const object = node.childForFieldName("object");
	const property =
		node.childForFieldName("attribute") ?? node.childForFieldName("property");
	if (!object || !property) return null;
	if (object.type === "identifier") {
		return `${context.modules.get(object.text) ?? object.text}.${property.text}`;
	}
	if (object.type === "call" || object.type === "call_expression") {
		const fn = object.childForFieldName("function");
		if (fn?.type === "identifier" && fn.text === "require") {
			const moduleName = stringLiteral(argumentNodes(object)[0]);
			if (moduleName)
				return `${normalizeJsModule(moduleName)}.${property.text}`;
		}
	}
	const nested = callName(object, context);
	return nested ? `${nested}.${property.text}` : property.text;
}

function resolveValue(
	node: SyntaxNode | null,
	context: ValueContext,
): string | null {
	if (!node) return null;
	const literal = stringLiteral(node);
	if (literal !== null) return literal;
	if (node.type === "identifier")
		return context.constants.get(node.text) ?? null;
	if (node.type === "parenthesized_expression")
		return resolveValue(children(node)[0] ?? null, context);
	if (["binary_operator", "binary_expression"].includes(node.type)) {
		const left = node.childForFieldName("left");
		const right = node.childForFieldName("right");
		const operator = node.children.find(
			(child) => child && !child.isNamed,
		)?.text;
		const leftValue = resolveValue(left, context);
		const rightValue = resolveValue(right, context);
		if (leftValue === null || rightValue === null) return null;
		if (operator === "+") return leftValue + rightValue;
		if (operator === "/") return join(leftValue, rightValue);
	}
	if (node.type === "call" || node.type === "call_expression") {
		const fn = node.childForFieldName("function");
		const name = fn ? callName(fn, context) : null;
		const args = argumentNodes(node);
		if (context.pathConstructors.has(name ?? "") || name === "Bun.file") {
			return resolveValue(args[0] ?? null, context);
		}
		if (["os.path.join", "path.join", "node:path.join"].includes(name ?? "")) {
			const values = args.map((arg) => resolveValue(arg, context));
			return values.every((value) => value !== null)
				? join(...(values as string[]))
				: null;
		}
		if (["path.resolve", "node:path.resolve"].includes(name ?? "")) {
			const values = args.map((arg) => resolveValue(arg, context));
			return values.every((value) => value !== null)
				? resolve(context.cwd, ...(values as string[]))
				: null;
		}
	}
	return null;
}

function addFinding(
	analysis: SourceAnalysis,
	capability: SourceFinding["capability"],
	path: string | null,
	evidence: string,
): void {
	analysis.findings.push({ capability, path, evidence });
	if (path === null)
		analysis.unresolvedEffects.push(`${evidence} has a dynamic path`);
}

function collectConstants(root: SyntaxNode, context: ValueContext): void {
	let changed = true;
	for (let pass = 0; pass < 4 && changed; pass++) {
		changed = false;
		walk(root, (node) => {
			if (node.type === "assignment") {
				const left = node.childForFieldName("left");
				const right = node.childForFieldName("right");
				if (left?.type !== "identifier" || !right) return;
				const value = resolveValue(right, context);
				if (value !== null && context.constants.get(left.text) !== value) {
					context.constants.set(left.text, value);
					changed = true;
				}
			}
			if (node.type === "variable_declarator") {
				const name = node.childForFieldName("name");
				const valueNode = node.childForFieldName("value");
				if (name?.type !== "identifier" || !valueNode) return;
				const value = resolveValue(valueNode, context);
				if (value !== null && context.constants.get(name.text) !== value) {
					context.constants.set(name.text, value);
					changed = true;
				}
			}
		});
	}
}

/**
 * Runtime-supplied standard-library modules. Their imports cannot execute
 * project dependency code. Filesystem and process operations are still
 * recognized below before generic calls through these modules are trusted.
 */
const PYTHON_TRUSTED_MODULE_PREFIXES = [
	"abc",
	"ast",
	"base64",
	"binascii",
	"bisect",
	"collections",
	"copy",
	"dataclasses",
	"datetime",
	"decimal",
	"difflib",
	"enum",
	"functools",
	"hashlib",
	"heapq",
	"io",
	"itertools",
	"json",
	"math",
	"operator",
	"os",
	"pathlib",
	"re",
	"shutil",
	"statistics",
	"string",
	"textwrap",
	"time",
	"typing",
	"unicodedata",
	"uuid",
] as const;

function hasTrustedPythonModulePrefix(name: string): boolean {
	return PYTHON_TRUSTED_MODULE_PREFIXES.some(
		(prefix) => name === prefix || name.startsWith(`${prefix}.`),
	);
}

const PYTHON_PURE_METHODS = new Set([
	"capitalize",
	"casefold",
	"center",
	"count",
	"decode",
	"encode",
	"endswith",
	"expandtabs",
	"find",
	"format",
	"index",
	"isalnum",
	"isalpha",
	"isascii",
	"isdecimal",
	"isdigit",
	"isidentifier",
	"islower",
	"isnumeric",
	"isprintable",
	"isspace",
	"istitle",
	"isupper",
	"join",
	"ljust",
	"lower",
	"lstrip",
	"partition",
	"removeprefix",
	"removesuffix",
	"replace",
	"rfind",
	"rindex",
	"rjust",
	"rpartition",
	"rsplit",
	"rstrip",
	"split",
	"splitlines",
	"startswith",
	"strip",
	"swapcase",
	"title",
	"translate",
	"upper",
	"zfill",
]);
const PYTHON_PURE_CALLS = new Set([
	"Path",
	"bool",
	"bytes",
	"dict",
	"enumerate",
	"float",
	"int",
	"isinstance",
	"join",
	"len",
	"list",
	"max",
	"min",
	"print",
	"range",
	"repr",
	"set",
	"sorted",
	"str",
	"sum",
	"tuple",
	"type",
	"zip",
]);
const PATH_WRITE_METHODS = new Set([
	"chmod",
	"hardlink_to",
	"mkdir",
	"rename",
	"replace",
	"rmdir",
	"symlink_to",
	"touch",
	"unlink",
	"write_bytes",
	"write_text",
]);
const PATH_READ_METHODS = new Set([
	"exists",
	"glob",
	"is_dir",
	"is_file",
	"iterdir",
	"lstat",
	"read_bytes",
	"read_text",
	"resolve",
	"rglob",
	"stat",
]);
const PYTHON_MODULE_WRITES: Record<string, number[]> = {
	"os.chmod": [0],
	"os.chown": [0],
	"os.fchmod": [0],
	"os.fchown": [0],
	"os.ftruncate": [0],
	"os.lchown": [0],
	"os.link": [0, 1],
	"os.open": [0],
	"os.mkfifo": [0],
	"os.mknod": [0],
	"os.makedirs": [0],
	"os.mkdir": [0],
	"os.remove": [0],
	"os.rename": [0, 1],
	"os.renames": [0, 1],
	"os.replace": [0, 1],
	"os.rmdir": [0],
	"os.symlink": [0, 1],
	"os.truncate": [0],
	"os.unlink": [0],
	"os.utime": [0],
	"shutil.chown": [0],
	"shutil.copymode": [0, 1],
	"shutil.copystat": [0, 1],
	"shutil.copy": [0, 1],
	"shutil.copy2": [0, 1],
	"shutil.copyfile": [0, 1],
	"shutil.copytree": [0, 1],
	"shutil.make_archive": [0],
	"shutil.move": [0, 1],
	"shutil.rmtree": [0],
	"shutil.unpack_archive": [1],
};
const PYTHON_MODULE_READS: Record<string, number[]> = {
	"os.access": [0],
	"os.listdir": [0],
	"os.lstat": [0],
	"os.readlink": [0],
	"os.scandir": [0],
	"os.stat": [0],
	"os.walk": [0],
	"shutil.disk_usage": [0],
};
const PYTHON_EXECUTE_CALLS = new Set([
	"eval",
	"exec",
	"os.fork",
	"os.forkpty",
	"os.popen",
	"os.startfile",
	"os.system",
]);
const PYTHON_EXECUTE_PREFIXES = [
	"os.exec",
	"os.posix_spawn",
	"os.spawn",
	"subprocess.",
];

function collectPythonImports(
	root: SyntaxNode,
	context: ValueContext,
	analysis: SourceAnalysis,
): Map<string, string> {
	const importedCalls = new Map<string, string>();
	walk(root, (node) => {
		if (node.type === "import_statement") {
			for (const child of children(node)) {
				if (child.type !== "dotted_name" && child.type !== "aliased_import")
					continue;
				const moduleName = child.text.split(/\s+as\s+/)[0];
				const local =
					child.text.split(/\s+as\s+/)[1] ?? moduleName.split(".")[0];
				if (!hasTrustedPythonModulePrefix(moduleName)) {
					analysis.unresolvedEffects.push(
						`Python import executes unanalyzed module: ${moduleName}`,
					);
				} else context.modules.set(local, moduleName);
			}
		}
		if (node.type === "import_from_statement") {
			const moduleNode = node.childForFieldName("module_name");
			const moduleName = moduleNode?.text;
			if (!moduleName) return;
			if (!hasTrustedPythonModulePrefix(moduleName)) {
				analysis.unresolvedEffects.push(
					`Python import executes unanalyzed module: ${moduleName}`,
				);
				return;
			}
			const names = node
				.childrenForFieldName("name")
				.filter((child): child is SyntaxNode => child !== null);
			for (const nameNode of names) {
				const parts = nameNode.text.split(/\s+as\s+/);
				importedCalls.set(parts[1] ?? parts[0], `${moduleName}.${parts[0]}`);
			}
		}
	});
	return importedCalls;
}

function analyzePython(root: SyntaxNode, cwd: string): SourceAnalysis {
	const analysis: SourceAnalysis = {
		findings: [],
		unresolvedEffects: [],
		parseErrors: [],
	};
	const context: ValueContext = {
		constants: new Map(),
		modules: new Map(),
		pathConstructors: new Set(["pathlib.Path"]),
		cwd,
	};
	const importedCalls = collectPythonImports(root, context, analysis);
	for (const [local, imported] of importedCalls) {
		if (imported === "pathlib.Path") context.pathConstructors.add(local);
	}
	collectConstants(root, context);

	walk(root, (node) => {
		if (node.type !== "call") return;
		const fn = node.childForFieldName("function");
		if (!fn) return;
		const args = argumentNodes(node);
		let name = callName(fn, context);
		if (name && importedCalls.has(name)) name = importedCalls.get(name) ?? name;

		if ((name === "open" && fn.type === "identifier") || name === "io.open") {
			const path = resolveValue(pythonArgument(args, 0, "file"), context);
			const mode =
				resolveValue(pythonArgument(args, 1, "mode"), context) ?? "r";
			const write = /[wax+]/.test(mode);
			addFinding(
				analysis,
				write ? "write" : "read",
				path,
				`Python open(${mode})`,
			);
			return;
		}
		if (name && PYTHON_MODULE_WRITES[name]) {
			for (const index of PYTHON_MODULE_WRITES[name]) {
				addFinding(
					analysis,
					"write",
					resolveValue(args[index] ?? null, context),
					`Python ${name}`,
				);
			}
			return;
		}
		if (name && PYTHON_MODULE_READS[name]) {
			for (const index of PYTHON_MODULE_READS[name]) {
				addFinding(
					analysis,
					"read",
					resolveValue(args[index] ?? null, context),
					`Python ${name}`,
				);
			}
			return;
		}
		if (fn.type === "attribute") {
			const object = fn.childForFieldName("object");
			const method = fn.childForFieldName("attribute")?.text;
			const receiverFunction =
				object?.type === "call" ? object.childForFieldName("function") : null;
			const receiverName = receiverFunction
				? callName(receiverFunction, context)
				: null;
			const isPathReceiver =
				(receiverName !== null && context.pathConstructors.has(receiverName)) ||
				(object?.type === "identifier" && context.constants.has(object.text));
			if (
				object?.type === "call" &&
				[
					"close",
					"flush",
					"read",
					"readline",
					"readlines",
					"write",
					"writelines",
				].includes(method ?? "")
			) {
				const objectFunction = object.childForFieldName("function");
				if (objectFunction && callName(objectFunction, context) === "open")
					return;
			}
			if (method === "open" && isPathReceiver) {
				const mode =
					resolveValue(pythonArgument(args, 0, "mode"), context) ?? "r";
				addFinding(
					analysis,
					/[wax+]/.test(mode) ? "write" : "read",
					resolveValue(object, context),
					`Python Path.open(${mode})`,
				);
				return;
			}
			if (method && isPathReceiver && PATH_WRITE_METHODS.has(method)) {
				const sourcePath = resolveValue(object, context);
				addFinding(analysis, "write", sourcePath, `Python Path.${method}`);
				if (["rename", "replace"].includes(method)) {
					addFinding(
						analysis,
						"write",
						resolveValue(args[0] ?? null, context),
						`Python Path.${method} destination`,
					);
				}
				return;
			}
			if (method && isPathReceiver && PATH_READ_METHODS.has(method)) {
				addFinding(
					analysis,
					"read",
					resolveValue(object, context),
					`Python Path.${method}`,
				);
				return;
			}
		}
		if (
			PYTHON_EXECUTE_CALLS.has(name ?? "") ||
			PYTHON_EXECUTE_PREFIXES.some((prefix) => name?.startsWith(prefix))
		) {
			addFinding(analysis, "execute", null, `Python ${name}`);
			return;
		}
		const operation = name?.split(".").at(-1);
		if (
			context.pathConstructors.has(name ?? "") ||
			PYTHON_PURE_CALLS.has(name ?? "") ||
			name === "os.path.join" ||
			hasTrustedPythonModulePrefix(name ?? "") ||
			(operation !== undefined && PYTHON_PURE_METHODS.has(operation))
		)
			return;
		analysis.unresolvedEffects.push(`Unknown Python call: ${name ?? fn.text}`);
	});
	return analysis;
}

function normalizeJsModule(moduleName: string): string {
	return moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
}

/** A static JSON load parses data; it does not execute a JavaScript module. */
function isJsonModule(moduleName: string): boolean {
	return moduleName.toLowerCase().endsWith(".json");
}

/**
 * Runtime modules whose imports are safe to trust. Filesystem and process
 * operations are recognized separately, so this only avoids false positives
 * for bundled module loading and non-mutating helpers.
 */
const JS_TRUSTED_MODULES = new Set([
	"assert",
	"assert/strict",
	"buffer",
	"bun:jsc",
	"bun:test",
	"bun:wrap",
	"child_process",
	"constants",
	"crypto",
	"events",
	"fs",
	"fs/promises",
	"os",
	"path",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"stream",
	"string_decoder",
	"timers",
	"timers/promises",
	"url",
	"util",
	"v8",
	"zlib",
]);

function hasTrustedJsModule(name: string): boolean {
	return [...JS_TRUSTED_MODULES].some(
		(moduleName) => name === moduleName || name.startsWith(`${moduleName}.`),
	);
}
const JS_WRITE_METHODS: Record<string, number[]> = {
	appendFile: [0],
	appendFileSync: [0],
	chmod: [0],
	chmodSync: [0],
	chown: [0],
	chownSync: [0],
	copyFile: [0, 1],
	copyFileSync: [0, 1],
	cp: [0, 1],
	cpSync: [0, 1],
	createWriteStream: [0],
	link: [0, 1],
	linkSync: [0, 1],
	lchown: [0],
	lchownSync: [0],
	lutimes: [0],
	lutimesSync: [0],
	mkdir: [0],
	mkdtemp: [0],
	mkdtempSync: [0],
	mkdirSync: [0],
	rename: [0, 1],
	renameSync: [0, 1],
	rm: [0],
	rmSync: [0],
	rmdir: [0],
	rmdirSync: [0],
	symlink: [0, 1],
	symlinkSync: [0, 1],
	truncate: [0],
	truncateSync: [0],
	unlink: [0],
	utimes: [0],
	utimesSync: [0],
	write: [0],
	writeSync: [0],
	unlinkSync: [0],
	writeFile: [0],
	writeFileSync: [0],
};
const JS_READ_METHODS: Record<string, number[]> = {
	access: [0],
	accessSync: [0],
	createReadStream: [0],
	existsSync: [0],
	lstat: [0],
	lstatSync: [0],
	opendir: [0],
	opendirSync: [0],
	readFile: [0],
	readFileSync: [0],
	readdir: [0],
	readdirSync: [0],
	readlink: [0],
	readlinkSync: [0],
	stat: [0],
	statSync: [0],
	watch: [0],
	watchFile: [0],
};
const JS_OPEN_METHODS = new Set(["open", "openSync"]);
const JS_PURE_PREFIXES = [
	"Buffer.",
	"console.",
	"JSON.",
	"Math.",
	"path.",
	"URL.",
	"URLSearchParams.",
];
const JS_PURE_CALLS = new Set([
	"Array",
	"BigInt",
	"Boolean",
	"Number",
	"Object",
	"String",
]);
const BUN_PURE_CALLS = new Set([
	"Bun.deepEquals",
	"Bun.escapeHTML",
	"Bun.gzipSync",
	"Bun.hash",
	"Bun.inspect",
	"Bun.nanoseconds",
	"Bun.sleep",
	"Bun.sleepSync",
	"Bun.stringWidth",
	"Bun.which",
]);
const BUN_EXECUTE_CALLS = new Set(["Bun.$", "Bun.spawn", "Bun.spawnSync"]);

function collectJsImports(
	root: SyntaxNode,
	context: ValueContext,
	analysis: SourceAnalysis,
): Map<string, string> {
	const importedCalls = new Map<string, string>();
	walk(root, (node) => {
		if (node.type === "variable_declarator") {
			const nameNode = node.childForFieldName("name");
			const valueNode = node.childForFieldName("value");
			if (nameNode && valueNode?.type === "call_expression") {
				const fn = valueNode.childForFieldName("function");
				const rawModule =
					fn?.type === "identifier" && fn.text === "require"
						? stringLiteral(argumentNodes(valueNode)[0])
						: null;
				if (rawModule) {
					const moduleName = normalizeJsModule(rawModule);
					if (!JS_TRUSTED_MODULES.has(moduleName) && !isJsonModule(rawModule)) {
						analysis.unresolvedEffects.push(
							`JavaScript require loads unanalyzed module: ${rawModule}`,
						);
					} else if (nameNode.type === "identifier") {
						context.modules.set(nameNode.text, moduleName);
					} else if (nameNode.type === "object_pattern") {
						for (const pattern of children(nameNode)) {
							if (pattern.type === "shorthand_property_identifier_pattern") {
								importedCalls.set(
									pattern.text,
									`${moduleName}.${pattern.text}`,
								);
							}
							if (pattern.type === "pair_pattern") {
								const imported = pattern.childForFieldName("key")?.text;
								const local = pattern.childForFieldName("value")?.text;
								if (imported && local)
									importedCalls.set(local, `${moduleName}.${imported}`);
							}
						}
					}
				}
			}
		}

		if (node.type !== "import_statement") return;
		const source = node.childForFieldName("source");
		const rawModule = source ? stringLiteral(source) : null;
		if (!rawModule) {
			analysis.unresolvedEffects.push("JavaScript import has a dynamic source");
			return;
		}
		const moduleName = normalizeJsModule(rawModule);
		if (isJsonModule(rawModule)) {
			addFinding(analysis, "read", rawModule, "JavaScript JSON import");
			return;
		}
		if (!JS_TRUSTED_MODULES.has(moduleName)) {
			analysis.unresolvedEffects.push(
				`JavaScript import executes unanalyzed module: ${rawModule}`,
			);
			return;
		}
		walk(node, (child) => {
			if (child.type === "import_clause") {
				const defaultImport = children(child).find(
					(part) => part.type === "identifier",
				)?.text;
				if (defaultImport) context.modules.set(defaultImport, moduleName);
			}
			if (child.type === "import_specifier") {
				const imported = child.childForFieldName("name")?.text;
				const local = child.childForFieldName("alias")?.text ?? imported;
				if (imported && local)
					importedCalls.set(local, `${moduleName}.${imported}`);
			}
			if (child.type === "namespace_import") {
				const local = children(child).find(
					(part) => part.type === "identifier",
				)?.text;
				if (local) context.modules.set(local, moduleName);
			}
		});
	});
	return importedCalls;
}

function jsOperationName(name: string): string {
	return name.split(".").at(-1) ?? name;
}

function analyzeJavaScript(root: SyntaxNode, cwd: string): SourceAnalysis {
	const analysis: SourceAnalysis = {
		findings: [],
		unresolvedEffects: [],
		parseErrors: [],
	};
	const context: ValueContext = {
		constants: new Map(),
		modules: new Map(),
		pathConstructors: new Set(),
		cwd,
	};
	const importedCalls = collectJsImports(root, context, analysis);
	collectConstants(root, context);

	walk(root, (node) => {
		if (node.type !== "call_expression") return;
		const fn = node.childForFieldName("function");
		if (!fn) return;
		const args = argumentNodes(node);
		let name = callName(fn, context);
		if (name && importedCalls.has(name)) name = importedCalls.get(name) ?? name;

		if (name === "require") {
			const moduleName = resolveValue(args[0] ?? null, context);
			if (moduleName && isJsonModule(moduleName)) {
				addFinding(analysis, "read", moduleName, "JavaScript require JSON");
			} else if (
				!moduleName ||
				!JS_TRUSTED_MODULES.has(normalizeJsModule(moduleName))
			) {
				analysis.unresolvedEffects.push(
					`JavaScript require loads unanalyzed module: ${moduleName ?? "dynamic"}`,
				);
			}
			return;
		}
		const operation = name ? jsOperationName(name) : "";
		if (BUN_EXECUTE_CALLS.has(name ?? "")) {
			addFinding(analysis, "execute", null, `JavaScript ${name}`);
			return;
		}
		if (name === "Bun.write") {
			addFinding(
				analysis,
				"write",
				resolveValue(args[0] ?? null, context),
				"Bun.write",
			);
			return;
		}
		if (name?.startsWith("Deno.") && operation.startsWith("write")) {
			addFinding(
				analysis,
				"write",
				resolveValue(args[0] ?? null, context),
				name,
			);
			return;
		}
		if (name?.startsWith("Deno.") && operation.startsWith("read")) {
			addFinding(
				analysis,
				"read",
				resolveValue(args[0] ?? null, context),
				name,
			);
			return;
		}
		const isFsCall = /^(fs|fs\/promises|fs\.promises)\./.test(name ?? "");
		if (isFsCall && JS_OPEN_METHODS.has(operation)) {
			const flags = resolveValue(args[1] ?? null, context) ?? "r";
			addFinding(
				analysis,
				/[wax+]/.test(flags) ? "write" : "read",
				resolveValue(args[0] ?? null, context),
				`Node ${name}(${flags})`,
			);
			return;
		}
		if (JS_WRITE_METHODS[operation] && isFsCall) {
			for (const index of JS_WRITE_METHODS[operation]) {
				addFinding(
					analysis,
					"write",
					resolveValue(args[index] ?? null, context),
					`Node ${name}`,
				);
			}
			return;
		}
		if (JS_READ_METHODS[operation] && isFsCall) {
			for (const index of JS_READ_METHODS[operation]) {
				addFinding(
					analysis,
					"read",
					resolveValue(args[index] ?? null, context),
					`Node ${name}`,
				);
			}
			return;
		}
		if (
			["eval", "Function"].includes(name ?? "") ||
			name?.startsWith("child_process.")
		) {
			addFinding(analysis, "execute", null, `JavaScript ${name}`);
			return;
		}
		if (
			name === "Bun.file" ||
			JS_PURE_CALLS.has(name ?? "") ||
			BUN_PURE_CALLS.has(name ?? "") ||
			hasTrustedJsModule(name ?? "") ||
			JS_PURE_PREFIXES.some((prefix) => name?.startsWith(prefix))
		)
			return;
		analysis.unresolvedEffects.push(
			`Unknown JavaScript call: ${name ?? fn.text}`,
		);
	});
	return analysis;
}

/** Analyze statically supplied Python, JavaScript, or TypeScript source. */
export async function analyzeSource(
	language: Exclude<EmbeddedLanguage, "shell">,
	source: string,
	options: SourceAnalysisOptions,
): Promise<SourceAnalysis> {
	const grammar = language === "python" ? "python" : language;
	const parser = await getParser(grammar);
	const tree = parser.parse(source);
	if (!tree) {
		return {
			findings: [],
			unresolvedEffects: [`${language} parser returned no syntax tree`],
			parseErrors: ["no syntax tree"],
		};
	}
	try {
		const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
		try {
			countNodes(tree.rootNode, maxNodes);
		} catch {
			return {
				findings: [],
				unresolvedEffects: [
					`${language} source exceeds the ${maxNodes}-node analysis limit`,
				],
				parseErrors: [],
			};
		}
		const analysis =
			language === "python"
				? analyzePython(tree.rootNode, options.cwd)
				: analyzeJavaScript(tree.rootNode, options.cwd);
		if (tree.rootNode.hasError) {
			analysis.parseErrors.push(`${language} source contains syntax errors`);
			analysis.unresolvedEffects.push(
				`${language} source contains syntax errors`,
			);
		}
		return analysis;
	} finally {
		tree.delete();
	}
}
