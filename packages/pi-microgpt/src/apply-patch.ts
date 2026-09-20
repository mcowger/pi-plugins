import { realpath } from "node:fs/promises";
import path from "node:path";
import { createApplyPatchTool } from "@paulpham157/apply-patch/src/index.ts";

type UpstreamTool = ReturnType<typeof createApplyPatchTool>;
type UpstreamExecute = UpstreamTool["execute"];
type ExecuteArgs = Parameters<UpstreamExecute>;

const HEADER_PATTERN = /^\*\*\* ((?:Add|Delete|Update) File|Move to): (.+)$/gm;

/**
 * Resolve a patch path to a real absolute location with no confinement.
 * Relative paths resolve against the session working directory; `..`
 * escapes and absolute paths anywhere on the filesystem are preserved.
 * Symlinks are followed so the upstream tool never sees a symlink
 * component to reject. Access policy is enforced by a separate mechanism.
 */
export async function resolveUnrestricted(base: string, patchPath: string): Promise<string> {
	const absolute = path.isAbsolute(patchPath) ? path.normalize(patchPath) : path.resolve(base, patchPath);
	let current = absolute;
	const missing: string[] = [];
	for (;;) {
		try {
			const real = await realpath(current);
			return missing.length === 0 ? real : path.join(real, ...missing.reverse());
		} catch (error) {
			if ((error as { code?: string })?.code !== "ENOENT") return absolute;
			const parent = path.dirname(current);
			if (parent === current) return absolute;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

/** Rewrite every patch header path to its unrestricted absolute location. */
export async function rewritePatchPaths(patchText: string, base: string): Promise<string> {
	const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const paths = new Set<string>();
	for (const match of normalized.matchAll(HEADER_PATTERN)) {
		if (match[2] !== undefined) paths.add(match[2]);
	}
	const resolved = new Map<string, string>();
	for (const patchPath of paths) {
		resolved.set(patchPath, await resolveUnrestricted(base, patchPath));
	}
	return normalized.replace(HEADER_PATTERN, (_line, kind: string, patchPath: string) => {
		return `*** ${kind}: ${resolved.get(patchPath) ?? patchPath}`;
	});
}

/**
 * Upstream `apply_patch` confined to the session working directory. This
 * wrapper resolves all header paths to real absolute locations first and
 * delegates with the filesystem root as cwd, lifting the confinement (and
 * the symlink-component rejection) entirely. Whole-patch validation,
 * overlap, and existing-target checks still apply.
 */
export function createUnrestrictedApplyPatchTool(): UpstreamTool {
	const upstream = createApplyPatchTool();
	const execute = upstream.execute as UpstreamExecute;
	return {
		...upstream,
		execute: (async (...args: ExecuteArgs) => {
			const [toolCallId, params, signal, onUpdate, ctx] = args;
			const rawInput =
				typeof params === "string" ? params : ((params as { input?: unknown }).input as string);
			const rewritten = await rewritePatchPaths(rawInput, (ctx as { cwd: string }).cwd);
			const nextParams = (typeof params === "string" ? rewritten : { ...params, input: rewritten }) as ExecuteArgs[1];
			const root = path.parse(path.resolve((ctx as { cwd: string }).cwd)).root;
			return execute(toolCallId, nextParams, signal, onUpdate, { ...ctx, cwd: root });
		}) as UpstreamExecute,
	};
}
