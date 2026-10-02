import { RUN_REGISTRY_SYMBOL } from "./constants.js";
import { isTerminalStatus, type SubagentStatus } from "./status.js";

export class RunTerminalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunTerminalError";
	}
}

export interface LifetimeUsage {
	input: number;
	output: number;
	cacheWrite: number;
}

export interface SubagentRunInit {
	id: string;
	subagentType: string;
	displayName: string;
	description?: string;
	outputFile?: string;
	startedAt?: number;
	parentSessionId?: string;
	initialStatus?: SubagentStatus;
	toolCallId?: string;
	maxTurns?: number;
	modelName?: string;
	tags?: string[];
}

export function lifetimeTotal(usage: LifetimeUsage): number {
	return usage.input + usage.output + usage.cacheWrite;
}

/**
 * One accepted child run. Created only after admission succeeds, so a refused
 * spawn throws before this exists and emits no id.
 */
export class SubagentRun {
	readonly id: string;
	readonly subagentType: string;
	readonly displayName: string;
	readonly description?: string;
	readonly startedAt: number;
	readonly parentSessionId?: string;
	readonly tags: readonly string[];
	readonly toolCallId?: string;
	readonly maxTurns?: number;
	readonly modelName?: string;
	outputFile?: string;
	/** Final result written to disk on completion; advertised in the notification. */ resultFile?: string;

	toolUses = 0;
	turnCount = 0;
	readonly lifetimeUsage: LifetimeUsage = {
		input: 0,
		output: 0,
		cacheWrite: 0,
	};
	resultText?: string;
	contextPercent?: number;

	private _status: SubagentStatus;
	private _endedAt?: number;
	private _error?: string;
	private _childSession?: unknown;
	private _disposeChild?: () => void;
	private _terminationIntent?: "stopped" | "aborted";
	private _terminationReason?: string;
	/** Set once a get_subagent_result call claims the result (blocks for it or reads it). */
	private _resultRequested = false;
	readonly abortController = new AbortController();

	private settledPromise: Promise<void>;
	private resolveSettled!: () => void;

	constructor(init: SubagentRunInit) {
		this.id = init.id;
		this.subagentType = init.subagentType;
		this.displayName = init.displayName;
		this.description = init.description;
		this.outputFile = init.outputFile;
		this.startedAt = init.startedAt ?? Date.now();
		this.parentSessionId = init.parentSessionId;
		this.toolCallId = init.toolCallId;
		this.maxTurns = init.maxTurns;
		this.modelName = init.modelName;
		this.tags = init.tags ?? [];
		this._status = init.initialStatus ?? "running";
		this.settledPromise = new Promise<void>((resolve) => {
			this.resolveSettled = resolve;
		});
	}

	attachChild(childSession: unknown, dispose: () => void): void {
		this._childSession = childSession;
		this._disposeChild = dispose;
	}

	get childSession(): unknown {
		return this._childSession;
	}

	disposeChild(): void {
		const dispose = this._disposeChild;
		this._disposeChild = undefined;
		this._childSession = undefined;
		dispose?.();
	}

	requestTermination(intent: "stopped" | "aborted", reason?: string): void {
		if (this.terminal) return;
		this._terminationIntent = intent;
		if (reason !== undefined) this._terminationReason = reason;
		this.abortController.abort();
	}

	get terminationIntent(): "stopped" | "aborted" | undefined {
		return this._terminationIntent;
	}

	/** Why termination was requested, e.g. a timeout. */
	get terminationReason(): string | undefined {
		return this._terminationReason;
	}

	get status(): SubagentStatus {
		return this._status;
	}

	get terminal(): boolean {
		return isTerminalStatus(this._status);
	}

	/**
	 * True once the result has been claimed by a `get_subagent_result` caller, so
	 * the completion notification must not fire a redundant turn for it.
	 */
	get resultRequested(): boolean {
		return this._resultRequested;
	}

	claimResult(): void {
		this._resultRequested = true;
	}

	get error(): string | undefined {
		return this._error;
	}

	get endedAt(): number | undefined {
		return this._endedAt;
	}

	get settled(): Promise<void> {
		return this.settledPromise;
	}

	/** Lifetime token total across every assistant response. */
	get totalTokens(): number {
		return lifetimeTotal(this.lifetimeUsage);
	}

	transition(
		next: SubagentStatus,
		detail?: { error?: string; summary?: string },
	): void {
		if (this.terminal) {
			if (next === this._status) return;
			throw new RunTerminalError(
				`run ${this.id} is already terminal (${this._status}); refusing ${next}`,
			);
		}
		this._status = next;
		if (detail?.error !== undefined) this._error = detail.error;
		if (detail?.summary !== undefined) this.resultText = detail.summary;
		if (isTerminalStatus(next)) {
			this._endedAt = Date.now();
			this.resolveSettled();
		}
	}
}

/** Process-global registry of accepted runs, keyed by run id. */
export class RunRegistry {
	private readonly runs = new Map<string, SubagentRun>();

	add(run: SubagentRun): void {
		this.runs.set(run.id, run);
	}

	get(id: string | undefined): SubagentRun | undefined {
		if (!id) return undefined;
		return this.runs.get(id);
	}

	delete(id: string): void {
		this.runs.delete(id);
	}

	list(): SubagentRun[] {
		return [...this.runs.values()];
	}

	get size(): number {
		return this.runs.size;
	}
}

export function getRunRegistry(): RunRegistry {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[RUN_REGISTRY_SYMBOL] as RunRegistry | undefined;
	if (existing) return existing;
	const registry = new RunRegistry();
	store[RUN_REGISTRY_SYMBOL] = registry;
	return registry;
}
