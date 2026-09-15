import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const targets: Record<string, { packageName: string; triple: string }> = {
	"darwin-arm64": { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
	"darwin-x64": { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
	"linux-arm64": { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
	"linux-x64": { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
	"win32-arm64": { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
	"win32-x64": { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
};

export const CODEX_APPLY_PATCH_FLAG = "--codex-run-as-apply-patch";

export function resolveCodexExecutable(platform = process.platform, arch = process.arch): string {
	const target = targets[`${platform}-${arch}`];
	if (!target) throw new Error(`OpenAI Codex does not support ${platform}-${arch}`);

	let packageJson: string;
	try {
		packageJson = require.resolve(`${target.packageName}/package.json`);
	} catch (error) {
		throw new Error(`Missing ${target.packageName}, the native optional dependency of @openai/codex`, { cause: error });
	}

	return join(dirname(packageJson), "vendor", target.triple, "bin", platform === "win32" ? "codex.exe" : "codex");
}
