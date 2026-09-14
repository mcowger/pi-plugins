import { describe, expect, it, beforeEach } from "bun:test";
import { DenyTracker } from "../../src/utils/deny-tracker.js";

describe("DenyTracker", () => {
	let tracker: DenyTracker;

	beforeEach(() => {
		tracker = new DenyTracker();
	});

	it("is not triggered when no events have been recorded", () => {
		expect(tracker.isTriggered(3, 60)).toBe(false);
	});

	it("is not triggered when fewer than maxDenies events are in the window", () => {
		const now = Date.now();
		tracker.record(now);
		tracker.record(now + 1000);
		// maxDenies=3, only 2 recorded
		expect(tracker.isTriggered(3, 60, now + 2000)).toBe(false);
	});

	it("is triggered when exactly maxDenies events are within the window", () => {
		const now = Date.now();
		tracker.record(now);
		tracker.record(now + 1000);
		tracker.record(now + 2000);
		// maxDenies=3, all 3 within 60s window
		expect(tracker.isTriggered(3, 60, now + 3000)).toBe(true);
	});

	it("is triggered when more than maxDenies events are within the window", () => {
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			tracker.record(now + i * 1000);
		}
		expect(tracker.isTriggered(3, 60, now + 6000)).toBe(true);
	});

	it("prunes events that have aged out of the window", () => {
		const now = Date.now();
		// Record 2 events that will age out (at now and now+500ms)
		tracker.record(now);
		tracker.record(now + 500);
		// Record 1 event within the window
		tracker.record(now + 55_000);

		// At now+61s the cutoff is now+1000ms, so both early events (now, now+500) are pruned;
		// only the event at now+55_000 remains.
		expect(tracker.isTriggered(3, 60, now + 61_000)).toBe(false);
		expect(tracker.size()).toBe(1);
	});

	it("is not triggered when all events have aged out", () => {
		const now = Date.now();
		tracker.record(now);
		tracker.record(now + 1000);
		tracker.record(now + 2000);

		// 61 seconds later, all 3 events are outside the 60s window
		expect(tracker.isTriggered(3, 60, now + 63_000)).toBe(false);
	});

	it("reset() clears all recorded events", () => {
		const now = Date.now();
		tracker.record(now);
		tracker.record(now + 1000);
		tracker.record(now + 2000);
		expect(tracker.isTriggered(3, 60, now + 3000)).toBe(true);

		tracker.reset();
		expect(tracker.size()).toBe(0);
		expect(tracker.isTriggered(3, 60, now + 3000)).toBe(false);
	});

	it("handles a window of 0 seconds (instant expiry)", () => {
		const now = Date.now();
		tracker.record(now - 1); // just outside a 0s window
		expect(tracker.isTriggered(1, 0, now)).toBe(false);
	});

	it("records multiple events and tracks size correctly", () => {
		for (let i = 0; i < 10; i++) {
			tracker.record();
		}
		expect(tracker.size()).toBe(10);
	});
});
