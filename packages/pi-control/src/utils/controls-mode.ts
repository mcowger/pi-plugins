/**
 * Process-global, session-scoped runtime mode for pi-controls.
 *
 * Pi loads each session's extensions in its own module instance (jiti
 * isolation, `moduleCache: false`), and in-process subagent child sessions run
 * in the same process as their parent. A closure-scoped `mode` therefore left
 * children enforcing after the parent switched to `ignore`, and their asks were
 * forwarded back to the parent UI — so `ignore` looked broken.
 *
 * The mode lives on `globalThis` and every instance reads the live value, the
 * same pattern the subagent registry uses (`utils/subagent.ts`). Modes are keyed
 * by a session's lineage root, not by the process: an in-process subagent child
 * resolves to the same root as its spawner, so it inherits the parent's mode,
 * while unrelated top-level sessions keep independent modes. Out-of-process
 * subagents are separate processes and keep their own mode.
 *
 * Lineage resolution lives in `utils/subagent.ts`
 * (`resolveSessionLineageRoot`); this module only stores a mode per scope.
 */

export type ControlsMode = "enforce" | "ignore" | "inform";

/** Mode used for any scope that has not been set explicitly. */
export const DEFAULT_CONTROLS_MODE: ControlsMode = "enforce";

/** Storage key for a session that exposes no id. */
const UNSCOPED_KEY = "";

export class ControlsModeStore {
	private readonly modes = new Map<string, ControlsMode>();

	/** The mode for `scope`, or `enforce` when it was never set. */
	get(scope?: string | null): ControlsMode {
		return this.modes.get(scope || UNSCOPED_KEY) ?? DEFAULT_CONTROLS_MODE;
	}

	set(scope: string | null | undefined, mode: ControlsMode): void {
		this.modes.set(scope || UNSCOPED_KEY, mode);
	}

	clear(scope?: string | null): void {
		this.modes.delete(scope || UNSCOPED_KEY);
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
