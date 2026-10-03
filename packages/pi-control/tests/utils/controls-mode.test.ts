import { describe, expect, it } from "bun:test";
import {
	ControlsModeStore,
	getControlsModeStore,
} from "../../src/utils/controls-mode.js";

describe("ControlsModeStore", () => {
	it("defaults to enforce", () => {
		expect(new ControlsModeStore().get()).toBe("enforce");
	});

	it("round-trips the last mode set", () => {
		const store = new ControlsModeStore();
		store.set("ignore");
		expect(store.get()).toBe("ignore");
		store.set("inform");
		expect(store.get()).toBe("inform");
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

		parent.set("ignore");
		expect(child.get()).toBe("ignore");
		parent.set("enforce");
	});
});
