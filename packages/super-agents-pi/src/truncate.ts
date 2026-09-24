const ARRAY_ITEM_LIMIT = 200;
const MIN_LIMIT = 64;

function jsonByteLength(value: unknown): number {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf-8");
}

/**
 * Deep-clones a value into something JSON-safe: bigints become strings,
 * functions are dropped, binary buffers become a short placeholder, and
 * cycles (an object appearing among its own ancestors) become "[Circular]".
 */
function sanitizeClone(value: unknown, ancestors: Set<unknown> = new Set()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "function") return undefined;
		return value;
	}

	if (value instanceof Uint8Array) {
		return `[binary ${value.byteLength} bytes]`;
	}

	if (ancestors.has(value)) {
		return "[Circular]";
	}

	if (Array.isArray(value)) {
		ancestors.add(value);
		const result = value.map((item) => sanitizeClone(item, ancestors));
		ancestors.delete(value);
		return result;
	}

	ancestors.add(value);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const sanitized = sanitizeClone(item, ancestors);
		if (sanitized !== undefined) result[key] = sanitized;
	}
	ancestors.delete(value);
	return result;
}

/** Clones an already-sanitized (cycle-free) value, capping string length and array length. */
function limitClone(value: unknown, limit: number): unknown {
	if (typeof value === "string") {
		if (value.length > limit) {
			return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
		}
		return value;
	}

	if (Array.isArray(value)) {
		const overflow = value.length > ARRAY_ITEM_LIMIT;
		const items = overflow ? value.slice(0, ARRAY_ITEM_LIMIT) : value;
		const result = items.map((item) => limitClone(item, limit));
		if (overflow) result.push(`[${value.length - ARRAY_ITEM_LIMIT} more items truncated]`);
		return result;
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = limitClone(item, limit);
		}
		return result;
	}

	return value;
}

export function boundJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; bytes: number } {
	const clone = sanitizeClone(value);
	const originalBytes = jsonByteLength(clone);
	if (originalBytes <= maxBytes) {
		return { value: clone, truncated: false, bytes: originalBytes };
	}

	let limit = Math.floor(maxBytes / 4);
	for (;;) {
		const limited = limitClone(clone, limit);
		const bytes = jsonByteLength(limited);
		if (bytes <= maxBytes) {
			return { value: limited, truncated: true, bytes };
		}
		limit = Math.floor(limit / 2);
		if (limit < MIN_LIMIT) break;
	}

	const fallback = {
		type: (value as Record<string, unknown> | null | undefined)?.type,
		truncated: true,
		originalBytes,
	};
	return { value: fallback, truncated: true, bytes: jsonByteLength(fallback) };
}
