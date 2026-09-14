import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	Language as TreeSitterLanguage,
	Parser as TreeSitterParser,
} from "@vscode/tree-sitter-wasm";

type TreeSitterModule = typeof import("@vscode/tree-sitter-wasm");
type TreeSitterModuleWithDefault = TreeSitterModule & {
	default?: TreeSitterModule;
};

interface TreeSitterRuntime {
	module: TreeSitterModule;
	wasmDir: string;
}

let runtimePromise: Promise<TreeSitterRuntime> | null = null;
const languagePromises = new Map<string, Promise<TreeSitterLanguage>>();

async function loadRuntime(): Promise<TreeSitterRuntime> {
	if (runtimePromise) return runtimePromise;

	runtimePromise = (async () => {
		const imported = (await import(
			"@vscode/tree-sitter-wasm"
		)) as TreeSitterModuleWithDefault;
		const treeSitter = imported.default ?? imported;
		const require = createRequire(import.meta.url);
		const coreWasm = require.resolve(
			"@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
		);
		const wasmDir = dirname(coreWasm);
		await treeSitter.Parser.init({
			locateFile: (file) => join(wasmDir, file),
		});
		return { module: treeSitter, wasmDir };
	})();

	return runtimePromise;
}

async function loadLanguage(name: string): Promise<TreeSitterLanguage> {
	let languagePromise = languagePromises.get(name);
	if (!languagePromise) {
		languagePromise = (async () => {
			const runtime = await loadRuntime();
			return runtime.module.Language.load(
				join(runtime.wasmDir, `tree-sitter-${name}.wasm`),
			);
		})();
		languagePromises.set(name, languagePromise);
	}
	return languagePromise;
}

/** Create a parser backed by one of the grammars bundled by VS Code. */
export async function createTreeSitterParser(
	grammar: "bash" | "javascript" | "python" | "typescript",
): Promise<TreeSitterParser> {
	const runtime = await loadRuntime();
	const language = await loadLanguage(grammar);
	const parser = new runtime.module.Parser();
	parser.setLanguage(language);
	return parser;
}
