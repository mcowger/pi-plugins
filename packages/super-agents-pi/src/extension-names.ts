// Extension-name matching, ported from AlexParamonov/pi-subagents-lite (MIT),
// src/agents/agent-runner.ts. Adapted to drop the optional git-remote lookup
// (this package never spawns processes) and to expose a small filtering API
// for agent frontmatter `extensions` / `exclude_extensions` specs.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionsSpec } from "./types.ts";

const packageNameCache = new Map<string, string | undefined>();

function resolvePackageShortName(extPath: string): string | undefined {
	const entry = path.resolve(extPath);
	let dir = path.dirname(entry);
	for (;;) {
		if (path.basename(dir) === "node_modules") return undefined;

		let pkg: { name?: unknown; pi?: { extensions?: unknown } };
		try {
			pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return undefined; // walked to the filesystem root
			dir = parent;
			continue;
		}

		// First package.json found — it's the package root; decide here.
		const entries = pkg.pi?.extensions;
		if (
			typeof pkg.name === "string" &&
			Array.isArray(entries) &&
			entries.some((e) => typeof e === "string" && path.resolve(dir, e) === entry)
		) {
			const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
			return short.toLowerCase();
		}
		return undefined;
	}
}

function extensionPackageName(extPath: string): string | undefined {
	if (packageNameCache.has(extPath)) return packageNameCache.get(extPath);
	const result = resolvePackageShortName(extPath);
	packageNameCache.set(extPath, result);
	return result;
}

function extractExtensionName(extPath: string): string {
	const parts = extPath.split(path.sep);

	// 1. Git package: .../git/github.com/<user>/<pkg>/...
	const gitIdx = parts.indexOf("git");
	if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
		return parts[gitIdx + 3];
	}

	// 2. npm package: .../node_modules/[...]pkg/...
	const nmIdx = parts.lastIndexOf("node_modules");
	if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
		const next = parts[nmIdx + 1];
		if (next.startsWith("@") && nmIdx + 2 < parts.length) {
			return parts[nmIdx + 2]; // @scope/pkg → pkg
		}
		return next;
	}

	// 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
	const extIdx = parts.lastIndexOf("extensions");
	if (extIdx !== -1 && extIdx + 1 < parts.length) {
		const afterExt = parts[extIdx + 1];
		if (afterExt && !afterExt.includes(".")) {
			return afterExt;
		}
		const file = parts[parts.length - 1];
		return path.basename(file, path.extname(file));
	}

	// Fallback: parent dir name
	return path.basename(path.dirname(extPath));
}

/**
 * The lowercased set of names an extension is known by: the name derived from
 * its path, plus its package's short name (scope stripped), when resolvable.
 */
export function extensionNames(extPath: string): string[] {
	const pathName = extractExtensionName(extPath).toLowerCase();
	const packageName = extensionPackageName(extPath)?.toLowerCase();
	const names = [pathName, packageName].filter((n): n is string => Boolean(n));
	return [...new Set(names)];
}

export function filterExtensions<T extends { path: string; resolvedPath: string }>(
	exts: T[],
	spec: ExtensionsSpec,
	exclude: string[],
	ownPackageDir: string,
): { kept: T[]; unmatched: string[] } {
	const ownPrefix = path.resolve(ownPackageDir) + path.sep;
	const candidates = exts.filter((e) => !path.resolve(e.resolvedPath).startsWith(ownPrefix));

	if (spec === "none") {
		return { kept: [], unmatched: [] };
	}

	if (spec === "all") {
		const excludeLower = exclude.map((n) => n.toLowerCase());
		const matched = new Set<string>();
		const kept = candidates.filter((e) => {
			const names = extensionNames(e.path);
			const hit = names.some((n) => excludeLower.includes(n));
			if (hit) {
				for (const n of names) if (excludeLower.includes(n)) matched.add(n);
			}
			return !hit;
		});
		const unmatched = excludeLower.filter((n) => !matched.has(n));
		return { kept, unmatched };
	}

	// spec is a list of requested names.
	const listLower = spec.map((n) => n.toLowerCase());
	const matched = new Set<string>();
	const kept = candidates.filter((e) => {
		const names = extensionNames(e.path);
		const hit = names.some((n) => listLower.includes(n));
		if (hit) {
			for (const n of names) if (listLower.includes(n)) matched.add(n);
		}
		return hit;
	});
	const unmatched = listLower.filter((n) => !matched.has(n));
	return { kept, unmatched };
}
