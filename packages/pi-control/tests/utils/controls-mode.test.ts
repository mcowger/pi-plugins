import { describe, expect, it } from "bun:test";
import {
	ControlsModeStore,
	getControlsModeStore,
} from "../../src/utils/controls-mode.js";

describe("ControlsModeStore", () => {
	it("defaults to enforce", () => {
		expect(new ControlsModeStore().get()).toBe("enforce");
		expect(new ControlsModeStore().get("session-a")).toBe("enforce");
	});

	it("round-trips the last mode set per scope", () => {
		const store = new ControlsModeStore();
		store.set("session-a", "ignore");
		expect(store.get("session-a")).toBe("ignore");
		store.set("session-a", "inform");
		expect(store.get("session-a")).toBe("inform");
	});

	it("keeps unrelated scopes independent", () => {
		const store = new ControlsModeStore();
		store.set("session-a", "ignore");
		store.set("session-b", "inform");
		expect(store.get("session-a")).toBe("ignore");
		expect(store.get("session-b")).toBe("inform");
		store.clear("session-a");
		expect(store.get("session-a")).toBe("enforce");
		// Clearing one scope must not disturb another.
		expect(store.get("session-b")).toBe("inform");
	});

	it("shares one store across module instances in a process", async () => {
		// Pi evaluates extensions per session in an isolated module instance
		// (jiti isolation, `moduleCache: false`). A cache-busted import stands in
		// for the child session's pi-controls instance: it must read the same
		// process-global store, or `ignore` in a parent leaves subagents enforcing.
		const specifier = `../../src/utils/controls-mode.js?session=${Date.now()}`;
		const fresh = (await import(
			specifier
		)) as typeof import("../../src/utils/controls-mode.js");

		const parent = getControlsModeStore();
		const child = fresh.getControlsModeStore();
		expect(child).toBe(parent);

		parent.set("session-a", "ignore");
		expect(child.get("session-a")).toBe("ignore");
		parent.clear("session-a");
	});
});
