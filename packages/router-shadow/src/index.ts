/**
 * `router-shadow` extension entry (REQUIREMENTS R4, R11–R13).
 *
 * Subscribes to `before_agent_start`: the sync handler snapshots the turn in
 * under 5 ms and detaches all network work. Candidates run in the background
 * (at most 2 turns in flight) and one JSON line per turn is appended to the
 * decisions log. Nothing here ever modifies the run.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Bundle, guardHashesForPrompt, loadBundle } from "./bundle.js";
import {
	defaultLogDir,
	loadConfig,
	resolvePlexusBaseUrl,
	type RouterShadowConfig,
} from "./config.js";
import { buildBoundedState } from "./context/bounded.js";
import {
	contentText,
	entriesToMessages,
	type EntryLike,
	messagesFromEntry,
	type Msg,
} from "./context/entries.js";
import { collapseWhitespace } from "./context/utf16.js";
import { createHttp } from "./http.js";
import {
	appendDecision,
	appendError,
	capErrorText,
	hashState,
	type DecisionRecord,
} from "./log.js";
import {
	buildTierMap,
	classifyActualSource,
	classifyOrigin,
	isAck,
	mapModelToTier,
	type TierMap,
} from "./origin.js";
import { route, TURN_TIMEOUT_MS, type CandidateResult } from "./route/route.js";
import {
	captureSnapshot,
	type SnapshotContext,
	type TurnSnapshot,
} from "./snapshot.js";
import { collectStatus, formatStatus } from "./status.js";

/** Channels the sibling subagents package emits on `pi.events`. */
const CHILD_CREATED = "subagents:child:session-created";
const CHILD_DISPOSED = "subagents:child:disposed";

/** Persisted `/router-shadow on|off` toggle entry. */
const TOGGLE_ENTRY_TYPE = "router-shadow-toggle";

const MAX_IN_FLIGHT = 2;
/** Settle window for the turn's persisted ancestry. Pi links run entries
 * (system message, user entry) at run start, which can lag the handler by
 * seconds; routing waits so candidates classify the same context the
 * experiment rebuilds. Falls back to the snapshot when the window lapses. */
const ENTRY_ID_WAIT_MS = 2000;
const SETTLE_POLL_MS = 100;

const extensionDir = fileURLToPath(new URL("..", import.meta.url));

interface UiSink {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export default async function routerShadow(pi: ExtensionAPI): Promise<void> {
	const subagentSessions = new Set<string>();
	let bundle: Bundle | null = null;
	let tierMap: TierMap = new Map();
	let bundleVersion = "unknown";
	let bundleFailed = false;
	let sessionEnabled = true;
	let lastInputSource: string | undefined;
	let lastUi: UiSink | null = null;
	let inFlight = 0;
	const controllers = new Set<AbortController>();

	const unsubscribeCreated = subscribeLifecycle(pi, subagentSessions);

	function config(): RouterShadowConfig {
		let settings: unknown;
		try {
			settings = (pi.getSettings() as Record<string, unknown>).routerShadow;
		} catch {
			settings = undefined;
		}
		let agentDir = "";
		try {
			agentDir = getAgentDir();
		} catch {
			agentDir = "";
		}
		return loadConfig({
			settings,
			extensionDir,
			plexusBaseUrl: resolvePlexusBaseUrl(process.env, agentDir),
		});
	}

	async function ensureBundle(notify: UiSink): Promise<boolean> {
		if (bundle || bundleFailed) return bundle !== null;
		const cfg = config();
		try {
			const [exemplarsRaw, modelsRaw] = await Promise.all([
				readFile(cfg.bundlePath, "utf8"),
				readFile(cfg.modelsPath, "utf8"),
			]);
			bundle = loadBundle(JSON.parse(exemplarsRaw));
			tierMap = buildTierMap(JSON.parse(modelsRaw));
			bundleVersion = bundle.version;
			return true;
		} catch (err) {
			bundleFailed = true;
			notify.notify(
				`[router-shadow] disabled: cannot load exemplar bundle (${(err as Error).message})`,
				"error",
			);
			return false;
		}
	}

	let missingCredsWarned = false;

	/** Sync credential gate: explicit key or a live provider fallback. */
	function checkPrerequisites(notify: UiSink, canResolveKey: boolean): boolean {
		const cfg = config();
		if (!cfg.apiBase || (!cfg.apiKey && !canResolveKey)) {
			if (!missingCredsWarned) {
				missingCredsWarned = true;
				notify.notify(
					"[router-shadow] disabled: no Plexus base URL (set PLEXUS_API_BASE or configure the plexus plugin) or no API key (set PLEXUS_API_KEY or configure plexus provider auth)",
					"warning",
				);
			}
			return false;
		}
		return true;
	}

	/** Live provider key, resolved the way the plexus provider itself does. */
	function keyResolverFrom(ctx: {
		modelRegistry?: {
			getApiKeyForProvider(provider: string): Promise<string | undefined>;
		};
	}): (() => Promise<string>) | undefined {
		const registry = ctx.modelRegistry;
		if (!registry) return undefined;
		return async (): Promise<string> => {
			try {
				return (await registry.getApiKeyForProvider("plexus")) ?? "";
			} catch {
				return "";
			}
		};
	}

	pi.on("input", (event) => {
		lastInputSource = event.source;
	});

	pi.on("session_start", async (_event, ctx) => {
		lastUi = ctx.ui as unknown as UiSink;
		sessionEnabled = readToggle(ctx.sessionManager.getBranch());
		await ensureBundle(ctx.ui as unknown as UiSink);
		checkPrerequisites(
			ctx.ui as unknown as UiSink,
			keyResolverFrom(ctx) !== undefined,
		);
	});

	pi.on("before_agent_start", (event, ctx) => {
		// R11.5: nothing here may ever surface in the transcript.
		try {
			handleTurn(event, ctx);
		} catch (err) {
			void appendError(defaultLogDir(), {
				ts: new Date().toISOString(),
				where: "before_agent_start",
				error: capErrorText((err as Error).message ?? String(err)),
			}).catch(() => {});
		}
	});

	function handleTurn(
		event: { prompt?: unknown; images?: unknown },
		ctx: SnapshotContext & {
			ui: unknown;
			modelRegistry?: {
				getApiKeyForProvider(provider: string): Promise<string | undefined>;
			};
		},
	): void {
		const handlerStart = Date.now();
		lastUi = ctx.ui as unknown as UiSink;
		const cfg = config();
		if (!cfg.enabled || !sessionEnabled) return;
		if (Math.random() >= cfg.sampleRate) return;
		// Resolve the plexus provider key the same way the provider itself
		// does; explicit settings/env keys take precedence (see runShadow).
		const resolveApiKey = keyResolverFrom(ctx);
		if (
			!checkPrerequisites(
				ctx.ui as unknown as UiSink,
				resolveApiKey !== undefined,
			)
		)
			return;
		if (bundleFailed || !bundle) return;

		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return;

		const snapshot = captureSnapshot(event, ctx, lastInputSource);
		lastInputSource = undefined;
		const handlerMs = Date.now() - handlerStart;

		const isSubagentSession =
			snapshot.parentSession !== null ||
			subagentSessions.has(snapshot.sessionId);
		const { origin, skill_name } = classifyOrigin(prompt, {
			isSubagentSession,
			inputSource: snapshot.inputSource,
		});
		if (isSubagentSession && !cfg.routeSubagents) {
			void writeSkipped(cfg, snapshot, handlerMs, "subagent");
			return;
		}

		if (inFlight >= MAX_IN_FLIGHT) {
			void writeSkipped(cfg, snapshot, handlerMs, "backpressure");
			return;
		}
		inFlight++;
		const controller = new AbortController();
		controllers.add(controller);
		const sessionManager = ctx.sessionManager;
		const readBranch = (): EntryLike[] | null => {
			try {
				return sessionManager.getBranch() as unknown as EntryLike[];
			} catch {
				return null;
			}
		};
		void runShadow(
			cfg,
			snapshot,
			{
				handlerMs,
				isSubagentSession,
				origin,
				skill_name,
				isAck: isAck(prompt),
			},
			readBranch,
			controller,
			resolveApiKey,
		)
			.catch((err: unknown) =>
				appendError(cfg.logDir, {
					ts: new Date().toISOString(),
					where: "runShadow",
					error: capErrorText((err as Error).message ?? String(err)),
				}),
			)
			.finally(() => {
				inFlight--;
				controllers.delete(controller);
			});
	}

	async function writeSkipped(
		cfg: RouterShadowConfig,
		snapshot: TurnSnapshot,
		handlerMs: number,
		reason: string,
	): Promise<void> {
		const guard = guardHashesForPrompt(snapshot.prompt);
		const record: DecisionRecord = {
			schema: 1,
			ts: new Date().toISOString(),
			session_file: snapshot.sessionFile,
			session_id: snapshot.sessionId,
			entry_id: null,
			parent_session: snapshot.parentSession,
			cwd: snapshot.cwd,
			origin: classifyOrigin(snapshot.prompt, {
				isSubagentSession: snapshot.parentSession !== null,
				inputSource: snapshot.inputSource,
			}).origin,
			skill_name: null,
			is_subagent_session: snapshot.parentSession !== null,
			is_ack: isAck(snapshot.prompt),
			actual: {
				provider: snapshot.model?.provider ?? "unknown",
				model: snapshot.model?.id ?? null,
				thinking: snapshot.thinking ?? null,
				tier: mapModelToTier(snapshot.model?.id, tierMap),
				source: "unknown",
			},
			prompt_chars: snapshot.prompt.length,
			prompt_norm_hash: guard.full,
			state_hash: hashState({ task: "classify_request", conversation: [] }),
			structural: {
				message_count: 0,
				has_images: snapshot.hasImages,
				api_type: "unknown",
			},
			bundle_version: bundleVersion,
			embedding: { latency_ms: null, error: null },
			candidates: {},
			skipped: reason,
			handler_ms: handlerMs,
		};
		try {
			await appendDecision(cfg.logDir, record);
		} catch (err) {
			await appendError(cfg.logDir, {
				ts: new Date().toISOString(),
				where: "writeSkipped",
				error: capErrorText((err as Error).message ?? String(err)),
			});
		}
	}

	async function runShadow(
		cfg: RouterShadowConfig,
		snapshot: TurnSnapshot,
		pre: {
			handlerMs: number;
			isSubagentSession: boolean;
			origin: ReturnType<typeof classifyOrigin>["origin"];
			skill_name: string | null;
			isAck: boolean;
		},
		readBranch: () => EntryLike[] | null,
		controller: AbortController,
		resolveApiKey: (() => Promise<string>) | undefined,
	): Promise<void> {
		const guard = guardHashesForPrompt(snapshot.prompt);
		const settleStarted = Date.now();
		// Settle first: candidates must classify the same persisted context
		// the experiment rebuilds (entries pi writes during the run, like the
		// system message, postdate the handler snapshot).
		const settled = await waitForSettledTurn({
			readBranch,
			snapshot,
			aborted: () => controller.signal.aborted,
		});
		const state = buildBoundedState(settled.messages);
		// Explicit settings/env keys win; otherwise inherit the live
		// plexus provider credential (OAuth-safe: resolved per turn).
		let apiKey = cfg.apiKey;
		if (!apiKey && resolveApiKey) {
			try {
				apiKey = await resolveApiKey();
			} catch {
				apiKey = "";
			}
		}
		if (!apiKey) {
			await writeSkipped(cfg, snapshot, pre.handlerMs, "missing-credentials");
			return;
		}
		const branchHasModelChange = snapshot.branch.some(
			(entry) => entry.type === "model_change",
		);
		const base = {
			schema: 1 as const,
			ts: new Date().toISOString(),
			session_file: snapshot.sessionFile,
			session_id: snapshot.sessionId,
			parent_session: snapshot.parentSession,
			cwd: snapshot.cwd,
			origin: pre.origin,
			skill_name: pre.skill_name,
			is_subagent_session: pre.isSubagentSession,
			is_ack: pre.isAck,
			actual: {
				provider: snapshot.model?.provider ?? "unknown",
				model: snapshot.model?.id ?? null,
				thinking: snapshot.thinking ?? null,
				tier: mapModelToTier(snapshot.model?.id, tierMap),
				source: classifyActualSource(
					pre.isSubagentSession,
					pre.origin,
					branchHasModelChange,
				),
			},
			prompt_chars: snapshot.prompt.length,
			prompt_norm_hash: guard.full,
			state_hash: hashState(state),
			structural: {
				message_count: state.structural.message_count,
				has_images: state.structural.has_images,
				api_type: state.structural.api_type,
			},
			bundle_version: bundleVersion,
			handler_ms: pre.handlerMs,
		};

		const http = createHttp({ apiBase: cfg.apiBase, apiKey });
		// The whole turn (settle + route) shares the 8 s cap: hand route
		// whatever budget is left after settling.
		const turnStarted = Date.now();
		const remainingTurnMs = Math.max(
			0,
			TURN_TIMEOUT_MS - (turnStarted - settleStarted),
		);
		let output: Awaited<ReturnType<typeof route>>;
		try {
			output = await route(
				{
					state,
					prompt: snapshot.prompt,
					candidates: cfg.candidates,
					k: cfg.k,
				},
				{
					post: http.postJson,
					bundle: bundle as Bundle,
					jevModel: cfg.jevModel,
					signal: controller.signal,
					timeouts: { turnMs: remainingTurnMs },
				},
			);
		} catch (err) {
			// The router never throws in practice; this guards the record write.
			await appendError(cfg.logDir, {
				ts: new Date().toISOString(),
				where: "route",
				error: capErrorText((err as Error).message ?? String(err)),
			});
			return;
		}

		// Pass route results through untouched: completed predictions keep
		// their tiers even if shutdown raced the write, and calls that were
		// in flight already carry error "aborted" from the transport layer.
		// (Rewriting successes to "aborted" here once corrupted real data.)
		const record: DecisionRecord = {
			...base,
			entry_id: settled.entryId,
			embedding: output.embedding,
			candidates: output.candidates,
			skipped: null,
		};
		await appendDecision(cfg.logDir, record);

		const prediction = output.candidates["jev-all"]?.tier;
		if (cfg.footer && prediction && lastUi) {
			try {
				lastUi.setStatus("router-shadow", `shadow: ${prediction}`);
			} catch {
				// Best-effort footer; never fail the turn.
			}
		}
	}

	pi.registerCommand("router-shadow", {
		description: "Shadow router status and on/off",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				sessionEnabled = sub === "on";
				pi.appendEntry(TOGGLE_ENTRY_TYPE, {
					enabled: sessionEnabled,
					at: new Date().toISOString(),
				});
				ctx.ui.notify(
					`[router-shadow] ${sessionEnabled ? "on" : "off"} for this session`,
				);
				return;
			}
			const report = await collectStatus(config().logDir);
			ctx.ui.notify(formatStatus(report));
		},
	});

	pi.on("session_shutdown", () => {
		for (const controller of controllers) {
			try {
				controller.abort();
			} catch {
				// Ignore abort errors during shutdown.
			}
		}
		unsubscribeCreated();
	});
}

function subscribeLifecycle(
	pi: ExtensionAPI,
	subagentSessions: Set<string>,
): () => void {
	let offCreated = () => {};
	let offDisposed = () => {};
	try {
		offCreated = pi.events.on(CHILD_CREATED, (data: unknown) => {
			const payload = (data ?? {}) as Record<string, unknown>;
			if (typeof payload.sessionId === "string" && payload.sessionId) {
				subagentSessions.add(payload.sessionId);
			}
		});
		offDisposed = pi.events.on(CHILD_DISPOSED, (data: unknown) => {
			const payload = (data ?? {}) as Record<string, unknown>;
			if (typeof payload.sessionId === "string") {
				subagentSessions.delete(payload.sessionId);
			}
		});
	} catch {
		// Event bus unavailable; parentSession headers still tag subagents.
	}
	return () => {
		try {
			offCreated();
		} catch {
			// Ignore unsubscribe errors during shutdown.
		}
		try {
			offDisposed();
		} catch {
			// Ignore unsubscribe errors during shutdown.
		}
	};
}

/** Latest persisted `/router-shadow on|off` toggle on the branch. */
function readToggle(
	branch: { type: string; customType?: string; data?: unknown }[],
): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === TOGGLE_ENTRY_TYPE) {
			const data = entry.data as { enabled?: unknown } | undefined;
			if (typeof data?.enabled === "boolean") return data.enabled;
		}
	}
	return true;
}

/**
 * Newest user-message entry whose collapsed text equals the prompt.
 * Prefers entries outside `excludeIds` (pre-existing branch entries): with
 * identical consecutive prompts this avoids resolving to the previous turn's
 * entry when the current one hasn't landed yet.
 */
export function findPromptEntryId(
	branch: {
		type: string;
		id: string;
		message?: { role?: string; content?: unknown };
	}[],
	prompt: string,
	excludeIds?: Set<string>,
): string | null {
	const collapsed = collapseWhitespace(prompt);
	const scan = (skipExcluded: boolean): string | null => {
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message?.role !== "user") continue;
			if (skipExcluded && excludeIds?.has(entry.id)) continue;
			if (
				collapseWhitespace(contentText(entry.message.content)) === collapsed
			) {
				return entry.id;
			}
		}
		return null;
	};
	return scan(true) ?? scan(false);
}

/** Settle signature: entry + shape of the mapped chain. */
function chainSignature(entryId: string | null, messages: Msg[]): string {
	const total = messages.reduce((sum, message) => sum + message.text.length, 0);
	const last = messages[messages.length - 1];
	return `${entryId}|${messages.length}|${total}|${last?.role}|${last?.text.slice(0, 32)}`;
}

/**
 * Wait for the turn's persisted ancestry to settle, then rebuild messages
 * from the prompt's entry — mirroring the experiment's reconstruction.
 *
 * The branch at `before_agent_start` predates entries pi persists during the
 * run (e.g. the system message); rebuilding late from the resolved entry
 * keeps `state_hash` comparable. Returns once the chain is stable across two
 * polls, or at the deadline with best-effort values.
 */
async function waitForSettledTurn(args: {
	readBranch: () => EntryLike[] | null;
	snapshot: TurnSnapshot;
	aborted: () => boolean;
}): Promise<{ entryId: string | null; messages: Msg[] }> {
	const { readBranch, snapshot } = args;
	const known = new Set(snapshot.knownIds);
	const fallback = () =>
		entriesToMessages(snapshot.branch, snapshot.prompt, snapshot.hasImages);
	const deadline = Date.now() + ENTRY_ID_WAIT_MS;
	const debug = process.env.ROUTER_SHADOW_DEBUG === "1";
	const trace = (...parts: unknown[]): void => {
		if (debug) console.error(`[router-shadow settle] ${parts.join(" ")}`);
	};
	let settled: { entryId: string | null; messages: Msg[] } | null = null;
	let prevKey: string | null = null;
	let polls = 0;
	for (;;) {
		if (args.aborted())
			return settled ?? { entryId: null, messages: fallback() };
		let branch: EntryLike[] | null = null;
		try {
			branch = readBranch();
		} catch {
			branch = null;
		}
		polls++;
		trace(
			`poll ${polls} branch=${branch ? branch.length : "null"} leaf=${branch?.[branch.length - 1]?.id}`,
		);
		if (branch && branch.length > 0) {
			const union = new Map<string, EntryLike>();
			for (const entry of snapshot.branch) {
				if (entry && typeof entry.id === "string") union.set(entry.id, entry);
			}
			for (const entry of branch) {
				if (entry && typeof entry.id === "string") union.set(entry.id, entry);
			}
			const merged = [...union.values()];
			const entryId = findPromptEntryId(merged, snapshot.prompt, known);
			const messages =
				entryId !== null
					? messagesFromEntry(
							merged,
							entryId,
							snapshot.prompt,
							snapshot.hasImages,
						)
					: fallback();
			const key = chainSignature(entryId, messages);
			trace(`poll ${polls} entry=${entryId} key=${key}`);
			// Never settle on a missing entry: the prompt entry always lands
			// (persisted with the turn), so null means "not yet", not "absent".
			// Stability only counts once the turn entry is in the chain —
			// entries pi persists around agent start (e.g. the system
			// message) can land right after the prompt entry itself.
			if (entryId !== null && key === prevKey) {
				trace(`poll ${polls} stable`);
				return { entryId, messages };
			}
			prevKey = key;
			settled = { entryId, messages };
		} else if (prevKey !== null) {
			return settled as { entryId: string | null; messages: Msg[] };
		}
		if (Date.now() >= deadline) {
			trace(`deadline polls=${polls} entry=${settled?.entryId}`);
			return settled ?? { entryId: null, messages: fallback() };
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, SETTLE_POLL_MS);
			(timer as unknown as { unref?: () => void }).unref?.();
		});
	}
}
