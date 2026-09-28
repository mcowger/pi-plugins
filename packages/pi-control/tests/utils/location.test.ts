import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePolicy } from "../../src/utils/location.js";
import type { ControlsResolvedConfig, Policy } from "../../src/config.js";

const strict: Policy = { defaultAction: "deny", rules: [] };
const relaxed: Policy = { defaultAction: "allow", rules: [] };

const config: ControlsResolvedConfig = {
	policies: { strict, relaxed },
	locations: {
		"/home/user/project": "strict",
		"/home/user": "relaxed",
		"/tmp": "relaxed",
	},
	defaultPolicy: null,
	cycleKey: "ctrl+shift+m",
	agentTimeout: null,
	nudgeTimeout: null,
	pathProtection: null,
	decisions: null,
};

const cwd = "/home/user";

describe("resolvePolicy", () => {
	it("returns the exact location policy", () => {
		expect(resolvePolicy("/tmp/foo", cwd, config)?.policy).toBe(relaxed);
	});

	it("returns the policy name", () => {
		expect(resolvePolicy("/tmp/foo", cwd, config)?.name).toBe("relaxed");
	});

	it("returns the most specific location (project over user home)", () => {
		expect(
			resolvePolicy("/home/user/project/src/file.ts", cwd, config)?.policy,
		).toBe(strict);
	});

	it("falls back to parent location", () => {
		expect(resolvePolicy("/home/user/other/file.ts", cwd, config)?.policy).toBe(
			relaxed,
		);
	});

	it("returns null when no location matches and no defaultPolicy", () => {
		expect(resolvePolicy("/var/log/syslog", cwd, config)).toBeNull();
	});

	it("returns defaultPolicy when no location matches and defaultPolicy is set", () => {
		const cfg: ControlsResolvedConfig = { ...config, defaultPolicy: "relaxed" };
		expect(resolvePolicy("/var/log/syslog", cwd, cfg)?.policy).toBe(relaxed);
	});

	it("handles exact match on location path", () => {
		expect(resolvePolicy("/home/user", cwd, config)?.policy).toBe(relaxed);
	});

	it("returns null for unknown defaultPolicy name", () => {
		const cfg: ControlsResolvedConfig = {
			...config,
			defaultPolicy: "nonexistent",
		};
		expect(resolvePolicy("/var/log/syslog", cwd, cfg)).toBeNull();
	});
});

describe("resolvePolicy — cwd special location key", () => {
	const cwdPath = "/home/user/myproject";
	const cwdConfig: ControlsResolvedConfig = {
		policies: {
			project: { defaultAction: "allow", rules: [] },
			locked: { defaultAction: "deny", rules: [] },
		},
		locations: {
			$cwd: "project",
			"/tmp": "locked",
		},
		defaultPolicy: "locked",
		cycleKey: "ctrl+shift+m",
		agentTimeout: null,
		nudgeTimeout: null,
		pathProtection: null,
		decisions: null,
	};

	it("matches the cwd directory itself", () => {
		expect(resolvePolicy(cwdPath, cwdPath, cwdConfig)?.name).toBe("project");
	});

	it("matches a path nested inside cwd", () => {
		expect(
			resolvePolicy(`${cwdPath}/src/index.ts`, cwdPath, cwdConfig)?.name,
		).toBe("project");
	});

	it("does not match a sibling directory", () => {
		expect(
			resolvePolicy("/home/user/otherproject", cwdPath, cwdConfig)?.name,
		).toBe("locked");
	});

	it("$cwd key loses to a longer explicit path (most-specific wins)", () => {
		const cfg: ControlsResolvedConfig = {
			...cwdConfig,
			locations: {
				$cwd: "project",
				[`${cwdPath}/src`]: "locked",
			},
		};
		expect(resolvePolicy(`${cwdPath}/src/index.ts`, cwdPath, cfg)?.name).toBe(
			"locked",
		);
	});
});

const symlinkRoots: string[] = [];

function makeSymlinkRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-controls-location-"));
	symlinkRoots.push(root);
	return root;
}

afterAll(() => {
	for (const root of symlinkRoots)
		rmSync(root, { recursive: true, force: true });
});

describe("resolvePolicy — symlink resolution", () => {
	it("applies the protected location policy when a link points into it", () => {
		const root = makeSymlinkRoot();
		const project = join(root, "project");
		const ssh = join(root, ".ssh");
		mkdirSync(project);
		mkdirSync(ssh);
		symlinkSync(ssh, join(project, "ssh"));

		const cfg: ControlsResolvedConfig = {
			...config,
			locations: { [project]: "relaxed", [ssh]: "strict" },
			defaultPolicy: "strict",
		};

		expect(
			resolvePolicy(join(project, "ssh", "id_rsa"), project, cfg)?.name,
		).toBe("strict");
	});

	it("resolves a symlinked location key to its real target", () => {
		const root = makeSymlinkRoot();
		const real = join(root, "real-project");
		mkdirSync(real);
		const link = join(root, "linked-project");
		symlinkSync(real, link);

		const cfg: ControlsResolvedConfig = {
			...config,
			locations: { [link]: "strict" },
			defaultPolicy: "relaxed",
		};

		expect(resolvePolicy(join(real, "src", "index.ts"), root, cfg)?.name).toBe(
			"strict",
		);
	});
});
