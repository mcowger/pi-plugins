/**
 * UTF-16 helpers (REQUIREMENTS R3, R6.3, DESIGN §9).
 *
 * JavaScript strings are UTF-16, so `s.length` already counts UTF-16 units
 * (a surrogate pair counts as 2) — exactly the "UTF-16 unit" of the spec.
 * This mirrors the experiment's `truncate_utf16`/`utf16_len` byte-for-byte:
 * the cut respects code-point boundaries and `N` is the units removed.
 */

/** Length in UTF-16 code units, matching the experiment's `utf16_len`. */
export function utf16Len(value: string): number {
	return value.length;
}

/**
 * Truncate to at most `maxUnits` UTF-16 units, appending `…[truncated N]`.
 * Never splits a surrogate pair: a code point that doesn't fit is dropped
 * whole, and `N` counts the removed units (suffix included in nothing —
 * the suffix is extra, mirroring the experiment).
 */
export function truncateUtf16(value: string, maxUnits: number): string {
	if (value.length <= maxUnits) return value;
	let units = 0;
	for (const ch of value) {
		const width = ch.length; // 1 (BMP) or 2 (surrogate pair)
		if (units + width > maxUnits) break;
		units += width;
	}
	const removed = value.length - units;
	return `${value.slice(0, units)}…[truncated ${removed}]`;
}

/** Collapse whitespace runs to one space and trim (no case folding). */
export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
