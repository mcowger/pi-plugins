import { randomInt } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_BATCH_MS } from "./constants.ts";
import type { EventContext, EventEmitter } from "./events.ts";
import { finalizeResult, formatRunResult } from "./results.ts";
import type { runChild } from "./runner.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgentDefinition, RunActivity, RunRecord, RunStatus, SuperAgentsConfig, TaskInput } from "./types.ts";

export interface ManagerDeps {
	config: SuperAgentsConfig;
	getAgents: () => Map<string, AgentDefinition>;
	runChild: typeof runChild; // injectable for tests
	emitter: EventEmitter;
	pushResult: (text: string, details: unknown) => void; // background delivery
	cwd: string;
	agentDir: string;
	ownPackageDir: string;
	parentSessionId: string;
	overflowRoot: string;
	warn: (msg: string) => void;
}

interface Waiter {
	idSet: Set<string>;
	checkAndSettle: () => void;
	settle: () => void;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;
const FINISHED_STATUSES = new Set<RunStatus>(["completed", "failed", "aborted", "turn_limited"]);
const PROGRESS_THROTTLE_MS = 250; // at most 4/s

export const MAX_ACTIVITY_ENTRIES = 20;
export const PREVIEW_MAX_CHARS = 4000;
const ARGS_PREVIEW_CHARS = 200;

/** Extracts concatenated text parts from an assistant message, if any. */
export function extractAssistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const msg = message as { role?: unknown; content?: unknown };
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
	const parts: string[] = [];
	for (const block of msg.content) {
		if (typeof block === "object" && block !== null) {
			const b = block as { type?: unknown; text?: unknown };
			if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
		}
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n");
}

export function previewArgs(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? String(args);
	} catch {
		text = String(args);
	}
	if (text.length > ARGS_PREVIEW_CHARS) return `${text.slice(0, ARGS_PREVIEW_CHARS)}…`;
	return text;
}

function trackEvent(record: RunRecord, event: { type: string } & Record<string, unknown>): void {
	const now = Date.now();
	if (event.type === "message_end") {
		const text = extractAssistantText(event.message);
		if (text !== undefined) {
			record.previewText =
				text.length > PREVIEW_MAX_CHARS
					? `${text.slice(0, PREVIEW_MAX_CHARS)}…[truncated ${text.length - PREVIEW_MAX_CHARS} chars]`
					: text;
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		const entry: RunActivity = {
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : `${now}`,
			toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
			argsPreview: previewArgs(event.args),
			status: "running",
			startedAt: now,
		};
		const activity = record.activity ?? [];
		activity.push(entry);
		while (activity.length > MAX_ACTIVITY_ENTRIES) activity.shift();
		record.activity = activity;
		return;
	}
	if (event.type === "tool_execution_end") {
		const activity = record.activity;
		if (!activity) return;
		const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		const entry =
			(id !== undefined ? activity.find((a) => a.toolCallId === id && a.status === "running") : undefined) ??
			[...activity].reverse().find((a) => a.status === "running");
		if (entry) {
			entry.status = event.isError === true ? "error" : "done";
			entry.endedAt = now;
		}
		return;
	}
	if (event.type === "turn_end") {
		const usage = record.usage;
		if (usage) usage.turns += 1;
		else {
			record.usage = {
				turns: 1,
				toolCalls: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			};
		}
	}
}

function isFinished(status: RunStatus): boolean {
	return FINISHED_STATUSES.has(status);
}

function generateId(taken: Set<string>): string {
	for (;;) {
		let id = "";
		for (let i = 0; i < ID_LENGTH; i++) {
			id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
		}
		if (!taken.has(id)) return id;
	}
}

function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

function summarizeRecord(record: RunRecord): Record<string, unknown> {
	return {
		id: record.id,
		name: record.name,
		slug: record.slug,
		background: record.background,
		status: record.status,
		model: record.model,
		thinking: record.thinking,
		overrideIgnored: record.overrideIgnored,
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		outputPath: record.outputPath,
		error: record.error,
		usage: record.usage,
	};
}

export class RunManager {
	#deps: ManagerDeps;
	#semaphore: Semaphore;
	#records = new Map<string, RunRecord>();
	#controllers = new Map<string, AbortController>();
	#waiters = new Set<Waiter>();
	#pendingPush = new Set<RunRecord>();
	#pushTimer: ReturnType<typeof setTimeout> | undefined;
	#shutdownCalled = false;

	constructor(deps: ManagerDeps) {
		this.#deps = deps;
		this.#semaphore = new Semaphore(deps.config.maxConcurrent);
	}

	startTasks(args: {
		tasks: TaskInput[];
		background: boolean;
		parentToolCallId: string;
		ctx: ExtensionContext;
		signal?: AbortSignal;
		onProgress?: (records: RunRecord[]) => void;
	}): { records: RunRecord[]; done: Promise<void> } {
		const { tasks, background, parentToolCallId, ctx, signal, onProgress } = args;

		const agents = this.#deps.getAgents();
		if (tasks.length < 1 || tasks.length > this.#deps.config.maxTasksPerCall) {
			throw new Error(`expected 1 to ${this.#deps.config.maxTasksPerCall} tasks per call, got ${tasks.length}`);
		}
		for (const [index, task] of tasks.entries()) {
			if (!agents.has(task.agent)) {
				const available = [...agents.keys()].sort().join(", ");
				throw new Error(`unknown agent '${task.agent}'. Available: ${available}`);
			}
			if (task.prompt.trim() === "") {
				throw new Error(`task ${index + 1} ('${task.agent}'): prompt must not be empty`);
			}
		}

		const takenNames = new Set<string>();
		for (const record of this.#records.values()) {
			if (!isFinished(record.status)) takenNames.add(record.name);
		}
		const usedIds = new Set(this.#records.keys());

		const pairs: Array<{ task: TaskInput; record: RunRecord; agent: AgentDefinition }> = [];
		for (const task of tasks) {
			// biome-ignore lint/style/noNonNullAssertion: agent existence already validated above
			const agent = agents.get(task.agent)!;
			const id = generateId(usedIds);
			usedIds.add(id);
			const name = uniqueName(task.name?.trim() || agent.slug, takenNames);
			takenNames.add(name);

			const record: RunRecord = {
				id,
				name,
				slug: agent.slug,
				prompt: task.prompt,
				background,
				parentToolCallId,
				status: "queued",
				createdAt: Date.now(),
				delivered: false,
			};
			this.#records.set(id, record);
			pairs.push({ task, record, agent });

			this.#deps.emitter.lifecycle({ agentId: id, name, slug: agent.slug, parentToolCallId, background }, "queued");
		}

		const batchRecords = pairs.map((p) => p.record);

		for (const { record } of pairs) {
			this.#controllers.set(record.id, new AbortController());
		}

		if (!background && signal) {
			const abortAll = () => {
				for (const { record } of pairs) this.#controllers.get(record.id)?.abort();
			};
			if (signal.aborted) abortAll();
			else signal.addEventListener("abort", abortAll, { once: true });
		}

		const throttle = { last: 0 };
		const jobs = pairs.map(({ task, record, agent }) =>
			this.#runOne({
				task,
				record,
				agent,
				background,
				parentToolCallId,
				ctx,
				batchRecords,
				onProgress: background ? undefined : onProgress,
				throttle,
			}),
		);

		const done = Promise.all(jobs).then(() => undefined);
		return { records: batchRecords, done };
	}

	async #runOne(opts: {
		task: TaskInput;
		record: RunRecord;
		agent: AgentDefinition;
		background: boolean;
		parentToolCallId: string;
		ctx: ExtensionContext;
		batchRecords: RunRecord[];
		onProgress?: (records: RunRecord[]) => void;
		throttle: { last: number };
	}): Promise<void> {
		const { task, record, agent, parentToolCallId, ctx, batchRecords, onProgress, throttle, background } = opts;
		const evCtx: EventContext = {
			agentId: record.id,
			name: record.name,
			slug: record.slug,
			parentToolCallId,
			background,
		};
		// biome-ignore lint/style/noNonNullAssertion: controller is set for every record before jobs start
		const controller = this.#controllers.get(record.id)!;
		const notifyProgress = () => onProgress?.(batchRecords);

		let release: (() => void) | undefined;
		try {
			release = await this.#semaphore.acquire(controller.signal);
		} catch {
			record.status = "aborted";
			record.resultText = "";
			this.#finishRecord(record, evCtx, notifyProgress);
			return;
		}

		record.status = "running";
		record.startedAt = Date.now();
		notifyProgress();

		let toolCalls = 0;
		const result = await this.#deps.runChild({
			agent,
			task,
			cwd: this.#deps.cwd,
			agentDir: this.#deps.agentDir,
			ctx,
			ownPackageDir: this.#deps.ownPackageDir,
			graceTurns: this.#deps.config.graceTurns,
			signal: controller.signal,
			onEvent: (event) => {
				this.#deps.emitter.session(evCtx, event);
				trackEvent(record, event as { type: string } & Record<string, unknown>);
				if (event.type === "tool_execution_start") {
					toolCalls += 1;
					// trackEvent already created the activity entry; sync the live tool-call count here
					// without resetting the turns counter that turn_end tracking maintains.
					if (record.usage) record.usage.toolCalls = toolCalls;
					else {
						record.usage = {
							turns: 0,
							toolCalls,
							tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							cost: 0,
						};
					}
				}
				const now = Date.now();
				if (now - throttle.last >= PROGRESS_THROTTLE_MS) {
					throttle.last = now;
					notifyProgress();
				}
			},
			onStarted: (info) => {
				record.model = info.model;
				record.thinking = info.thinking;
				record.overrideIgnored = info.overrideIgnored;
				this.#deps.emitter.lifecycle(evCtx, "started", { ...info });
			},
			warn: this.#deps.warn,
		});

		release();

		const finalized = await finalizeResult({
			record,
			text: result.text,
			maxResultBytes: this.#deps.config.maxResultBytes,
			overflowRoot: this.#deps.overflowRoot,
			parentSessionId: this.#deps.parentSessionId,
		});

		record.status = result.status;
		record.usage = result.usage;
		record.error = result.error;
		record.outputPath = finalized.outputPath;
		record.resultText = finalized.inlineText;

		this.#finishRecord(record, evCtx, notifyProgress);
	}

	#finishRecord(record: RunRecord, evCtx: EventContext, notifyProgress: () => void): void {
		record.endedAt = Date.now();
		this.#controllers.delete(record.id);
		this.#deps.emitter.lifecycle(evCtx, "finished", { status: record.status });
		notifyProgress();
		this.#notifyWaiters(record.id);
		if (record.background && !record.delivered && !this.#shutdownCalled) {
			this.#enqueuePush(record);
		}
	}

	#enqueuePush(record: RunRecord): void {
		this.#pendingPush.add(record);
		if (this.#pushTimer === undefined) {
			this.#pushTimer = setTimeout(() => this.#firePush(), BACKGROUND_BATCH_MS);
		}
	}

	#firePush(): void {
		this.#pushTimer = undefined;
		const toPush = [...this.#pendingPush].filter((r) => !r.delivered && !this.#isCoveredByActiveWaiter(r.id));
		this.#pendingPush.clear();
		if (toPush.length === 0) return;

		for (const r of toPush) r.delivered = true;

		const body = toPush.map((r) => formatRunResult(r, r.resultText ?? "")).join("\n\n");
		const text = `Background sub-agent results:\n\n${body}`;
		this.#deps.pushResult(text, { runs: toPush.map(summarizeRecord) });
	}

	#isCoveredByActiveWaiter(id: string): boolean {
		for (const waiter of this.#waiters) {
			if (waiter.idSet.has(id)) return true;
		}
		return false;
	}

	#notifyWaiters(id: string): void {
		for (const waiter of [...this.#waiters]) {
			if (waiter.idSet.has(id)) waiter.checkAndSettle();
		}
	}

	async wait(
		ids: string[] | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ finished: RunRecord[]; pending: RunRecord[] }> {
		let targetIds: string[];
		if (ids === undefined) {
			targetIds = [...this.#records.values()].filter((r) => r.background && !r.delivered).map((r) => r.id);
		} else {
			const unknown = ids.filter((id) => !this.#records.has(id));
			if (unknown.length > 0) {
				throw new Error(`unknown agent id(s): ${unknown.join(", ")}`);
			}
			targetIds = ids;
		}

		const idSet = new Set(targetIds);

		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const onAbort = () => settle();

			const settle = () => {
				if (settled) return;
				settled = true;
				this.#waiters.delete(waiter);
				if (timer !== undefined) clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);

				const finished: RunRecord[] = [];
				const pending: RunRecord[] = [];
				for (const id of targetIds) {
					const record = this.#records.get(id);
					if (!record) continue;
					if (isFinished(record.status)) {
						record.delivered = true;
						finished.push(record);
					} else {
						pending.push(record);
					}
				}
				resolve({ finished, pending });
			};

			const checkAndSettle = () => {
				const allDone = targetIds.every((id) => {
					const record = this.#records.get(id);
					return record !== undefined && isFinished(record.status);
				});
				if (allDone) settle();
			};

			const waiter: Waiter = { idSet, checkAndSettle, settle };
			this.#waiters.add(waiter);

			if (signal?.aborted) {
				settle();
				return;
			}
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(settle, timeoutMs);

			checkAndSettle();
		});
	}

	stop(idsOrNames: string[]): { stopped: string[]; notFound: string[]; alreadyFinished: string[] } {
		const stopped: string[] = [];
		const notFound: string[] = [];
		const alreadyFinished: string[] = [];

		for (const key of idsOrNames) {
			const record = this.#records.get(key) ?? [...this.#records.values()].find((r) => r.name === key);
			if (!record) {
				notFound.push(key);
				continue;
			}
			if (isFinished(record.status)) {
				alreadyFinished.push(key);
				continue;
			}
			this.#controllers.get(record.id)?.abort();
			stopped.push(key);
		}

		return { stopped, notFound, alreadyFinished };
	}

	status(idsOrNames?: string[]): RunRecord[] {
		const all = [...this.#records.values()].sort((a, b) => b.createdAt - a.createdAt);
		if (idsOrNames === undefined) return all;
		const unknown: string[] = [];
		const found: RunRecord[] = [];
		for (const key of idsOrNames) {
			const record = this.#records.get(key) ?? all.find((r) => r.name === key);
			if (!record) unknown.push(key);
			else if (!found.includes(record)) found.push(record);
		}
		if (unknown.length > 0) throw new Error(`unknown agent id(s): ${unknown.join(", ")}`);
		return found;
	}

	shutdown(): void {
		this.#shutdownCalled = true;
		for (const controller of this.#controllers.values()) controller.abort();
		if (this.#pushTimer !== undefined) {
			clearTimeout(this.#pushTimer);
			this.#pushTimer = undefined;
		}
		this.#pendingPush.clear();
		for (const waiter of [...this.#waiters]) waiter.settle();
	}
}
