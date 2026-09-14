import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

interface SuppressionResult {
	deleted: Record<string, string>;
	remaining: Record<string, string | undefined>;
}

function suppressInIsolation(env: Record<string, string>, enabledProviders: string[]): SuppressionResult {
	const script = `
		import { suppressProviderEnvVars } from "./src/provider-env.ts";
		const deleted = suppressProviderEnvVars(${JSON.stringify(enabledProviders)});
		console.log(JSON.stringify({ deleted, remaining: ${JSON.stringify(Object.keys(env))}.reduce((result, key) => ({ ...result, [key]: process.env[key] }), {}) }));
	`;
	const result = spawnSync(process.execPath, ["--eval", script], {
		cwd: process.cwd(),
		env: { PATH: process.env.PATH ?? "", ...env },
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(result.stderr);
	}

	return JSON.parse(result.stdout) as SuppressionResult;
}

describe("suppressProviderEnvVars", () => {
	it("suppresses credentials discovered from Pi's current provider registry", () => {
		const result = suppressInIsolation({ ANT_LING_API_KEY: "ant-ling-key" }, ["openai"]);

		expect(result).toEqual({ deleted: { ANT_LING_API_KEY: "ant-ling-key" }, remaining: {} });
	});

	it("suppresses ambient Amazon Bedrock credentials", () => {
		const result = suppressInIsolation({ AWS_PROFILE: "development" }, ["openai"]);

		expect(result).toEqual({ deleted: { AWS_PROFILE: "development" }, remaining: {} });
	});

	it("preserves credentials shared with an enabled provider", () => {
		const result = suppressInIsolation({ OPENCODE_API_KEY: "opencode-key" }, ["opencode"]);

		expect(result).toEqual({ deleted: {}, remaining: { OPENCODE_API_KEY: "opencode-key" } });
	});
});
