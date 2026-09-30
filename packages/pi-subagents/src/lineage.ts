import { AsyncLocalStorage } from "node:async_hooks";
import { LINEAGE_REGISTRY_SYMBOL } from "./constants.js";
import type { Lineage, ToolPolicy } from "./types.js";

const lineageStore = new AsyncLocalStorage<Lineage>();

export class LineageRegistry {
	private readonly sessions = new Map<string, Lineage>();

	register(lineage: Lineage): void {
		this.sessions.set(lineage.sessionId, lineage);
	}

	get(sessionId: string | undefined): Lineage | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId);
	}

	delete(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.sessions.delete(sessionId);
	}

	get size(): number {
		return this.sessions.size;
	}
}

/**
 * Process-global lineage registry. Each Pi session loads extensions in its own
 * jiti module instance, so cross-session facts must live on `globalThis`.
 */
export function getLineageRegistry(): LineageRegistry {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[LINEAGE_REGISTRY_SYMBOL] as
		| LineageRegistry
		| undefined;
	if (existing) return existing;
	const registry = new LineageRegistry();
	store[LINEAGE_REGISTRY_SYMBOL] = registry;
	return registry;
}

export function runWithLineage<T>(lineage: Lineage, fn: () => T): T {
	return lineageStore.run(lineage, fn);
}

export function currentLineage(): Lineage | undefined {
	return lineageStore.getStore();
}

/**
 * Compute the child lineage for a spawn. `ceiling` only ever narrows: a
 * per-agent `maxDepth` cannot widen the inherited lineage (section 6).
 */
export function childLineage(
	parent: Lineage,
	childSessionId: string,
	options: { runId: string; policy: ToolPolicy; agentMaxDepth?: number },
): Lineage {
	const depth = parent.depth + 1;
	const ceiling =
		options.agentMaxDepth === undefined
			? parent.ceiling
			: Math.min(parent.ceiling, options.agentMaxDepth);
	return {
		sessionId: childSessionId,
		depth,
		ceiling,
		parentSessionId: parent.sessionId,
		runId: options.runId,
		policy: options.policy,
	};
}

/** Whether the spawner may be exposed at this depth. */
export function canSpawn(lineage: Lineage): boolean {
	return lineage.depth < lineage.ceiling;
}

/** Resolve the lineage for a session: registry first, then async context. */
export function resolveLineage(
	sessionId: string | undefined,
): Lineage | undefined {
	const fromRegistry = getLineageRegistry().get(sessionId);
	if (fromRegistry) return fromRegistry;
	const fromContext = currentLineage();
	if (fromContext && (!sessionId || fromContext.sessionId === sessionId))
		return fromContext;
	return undefined;
}
