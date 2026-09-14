/**
 * Sliding-window deny counter for the "agent timeout" circuit breaker.
 *
 * Tracks timestamps of recent deny decisions. When the count of denies within
 * the configured window meets or exceeds `maxDenies`, `isTriggered` returns
 * true, signalling that the next deny should be escalated to an interactive
 * "ask" instead of a silent block.
 *
 * The window is purely time-based (sliding), so the tracker naturally resets
 * as old events age out — no explicit reset is needed in normal use.
 */
export class DenyTracker {
	private readonly timestamps: number[] = [];

	/**
	 * Record a new deny event at the current time.
	 * Call this *before* checking `isTriggered` so the current event counts.
	 */
	record(now = Date.now()): void {
		this.timestamps.push(now);
	}

	/**
	 * Returns true when the number of deny events within the last
	 * `windowSeconds` seconds is ≥ `maxDenies`.
	 *
	 * Prunes expired entries as a side effect to keep memory bounded.
	 */
	isTriggered(
		maxDenies: number,
		windowSeconds: number,
		now = Date.now(),
	): boolean {
		const cutoff = now - windowSeconds * 1000;
		// Prune entries outside the window.
		while (
			this.timestamps.length > 0 &&
			(this.timestamps[0] as number) < cutoff
		) {
			this.timestamps.shift();
		}
		return this.timestamps.length >= maxDenies;
	}

	/** Reset all recorded events. Useful for testing. */
	reset(): void {
		this.timestamps.length = 0;
	}

	/** Number of deny events currently within an arbitrary window (for testing). */
	size(): number {
		return this.timestamps.length;
	}
}
