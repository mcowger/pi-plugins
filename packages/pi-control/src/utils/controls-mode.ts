/**
 * Process-global runtime mode for pi-controls.
 *
 * Pi loads each session's extensions in its own module instance (jiti
 * isolation, `moduleCache: false`), and in-process subagent child sessions run
 * in the same process as their parent. A closure-scoped `mode` therefore left
 * children enforcing after the parent switched to `ignore`, and their asks were
 * forwarded back to the parent UI — so `ignore` looked broken.
 *
 * The mode lives on `globalThis` and every instance reads the live value, the
 * same pattern the subagent registry uses (`utils/subagent.ts`). Out-of-process
 * subagents are separate processes and keep their own mode.
 */

export type ControlsMode = "enforce" | "ignore" | "inform";

export class ControlsModeStore {
	private current: ControlsMode = "enforce";

	get(): ControlsMode {
		return this.current;
	}

	set(mode: ControlsMode): void {
		this.current = mode;
	}
}

const CONTROLS_MODE_KEY = Symbol.for("@mcowger/pi-control:controls-mode");

/** Process-global mode store, shared by every pi-controls instance. */
export function getControlsModeStore(): ControlsModeStore {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[CONTROLS_MODE_KEY] as ControlsModeStore | undefined;
	if (existing) return existing;
	const created = new ControlsModeStore();
	store[CONTROLS_MODE_KEY] = created;
	return created;
}
