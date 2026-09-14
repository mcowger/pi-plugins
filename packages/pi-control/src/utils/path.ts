import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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
