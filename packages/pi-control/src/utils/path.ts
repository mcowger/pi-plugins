import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Expand leading ~ to the home directory. */
export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return `${homedir()}${p.slice(1)}`;
	return p;
}

/** Resolve a path to an absolute path, expanding ~ and relative segments. */
export function normalizePath(p: string, cwd: string): string {
	const expanded = expandHome(p);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Resolve a path to an absolute, symlink-free path.
 *
 * Policy location rules must be evaluated against the real filesystem target:
 * a symlink created inside a permitted directory but pointing at a protected
 * one (e.g. `./ssh -> ~/.ssh`) must resolve to the protected location instead
 * of inheriting the permitted directory's policy.
 *
 * The target may not exist yet (a file about to be written), so the longest
 * existing ancestor is resolved and the remaining segments are appended
 * unchanged. When no ancestor resolves, the lexically-normalised path is
 * returned.
 */
export function canonicalizePath(p: string, cwd: string): string {
	return resolveSymlinks(normalizePath(p, cwd));
}

function resolveSymlinks(absolutePath: string): string {
	const trailing: string[] = [];
	let current = absolutePath;
	while (true) {
		try {
			const real = realpathSync(current);
			return trailing.length > 0 ? join(real, ...trailing) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolutePath;
			trailing.unshift(basename(current));
			current = parent;
		}
	}
}
