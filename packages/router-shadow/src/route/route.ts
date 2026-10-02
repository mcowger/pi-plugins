/**
 * Shadow router orchestration (REQUIREMENTS §7, R16.1).
 *
 * Pure module with I/O injected via `deps`: `jev-all` and `jev-zeroshot`
 * start immediately, one shared embedding feeds `jev-k24` (and `flash-k24`
 * when enabled), everything settles under the whole-turn cap. Experiment #3
 * can call this from a `registerVirtualModel()` router unchanged.
 */

import {
	type Bundle,
	type Tier,
	countGuardExcluded,
	exemplarLine,
	guardHashesForPrompt,
	topK,
} from "../bundle.js";
import type { BoundedState } from "../context/bounded.js";
import { contextView } from "../context/view.js";
import type { PostJson } from "../http.js";
import { fetchQueryEmbedding } from "./embed.js";
import { callFlash } from "./flash.js";
import { callJev, jevRequestBody, jevZeroShotRequestBody } from "./jev.js";

export const TURN_TIMEOUT_MS = 8000;
export const DEFAULT_K = 24;

export const KNOWN_CANDIDATES = [
	"jev-all",
	"jev-k24",
	"jev-zeroshot",
	"flash-k24",
];

export interface CandidateResult {
	tier: Tier | null;
	probs: Record<Tier, number> | null;
	tier_expected: number | null;
	confidence: number | null;
	latency_ms: number;
	input_tokens: number | null;
	cost: number | null;
	excluded_exemplars?: number;
	exemplars?: string[];
	error: string | null;
}

export interface RouteInput {
	state: BoundedState;
	prompt: string;
	candidates: string[];
	k: number;
}

export interface RouteTimeouts {
	jevMs: number;
	embedMs: number;
	flashMs: number;
	turnMs: number;
}

export interface RouteDeps {
	post: PostJson;
	bundle: Bundle;
	jevModel: string;
	signal?: AbortSignal;
	now?: () => number;
	timeouts?: Partial<RouteTimeouts>;
}

export interface RouteOutput {
	embedding: { latency_ms: number | null; error: string | null };
	candidates: Record<string, CandidateResult>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function failedCandidate(
	latencyMs: number,
	error: string,
	extra?: Partial<CandidateResult>,
): CandidateResult {
	return {
		tier: null,
		probs: null,
		tier_expected: null,
		confidence: null,
		latency_ms: latencyMs,
		input_tokens: null,
		cost: null,
		error,
		...extra,
	};
}

export async function route(
	input: RouteInput,
	deps: RouteDeps,
): Promise<RouteOutput> {
	const now = deps.now ?? Date.now;
	const started = now();
	const timeouts: RouteTimeouts = {
		jevMs: 3000,
		embedMs: 2000,
		flashMs: 5000,
		turnMs: TURN_TIMEOUT_MS,
		...deps.timeouts,
	};
	const deadline = started + timeouts.turnMs;

	/** Remaining whole-turn budget, capped at `ms`. */
	function budget(ms: number): number {
		return Math.max(0, Math.min(ms, deadline - now()));
	}

	/** This call's share of the whole-turn budget. */
	function childTimeoutMs(timeoutMs: number): number {
		return budget(timeoutMs);
	}

	const guard = guardHashesForPrompt(input.prompt);
	const k = input.k > 0 ? input.k : DEFAULT_K;
	const wanted = input.candidates.filter((id) => KNOWN_CANDIDATES.includes(id));
	const unknown = input.candidates.filter(
		(id) => !KNOWN_CANDIDATES.includes(id),
	);
	const candidates: Record<string, CandidateResult> = {};
	for (const id of unknown) {
		candidates[id] = failedCandidate(0, "unknown_candidate");
	}

	const embedding: RouteOutput["embedding"] = {
		latency_ms: null,
		error: null,
	};

	async function runJevAll(): Promise<void> {
		const t0 = now();
		const eligible = deps.bundle.items.filter(
			(item) =>
				item.prompt_norm_hash !== guard.full &&
				item.prompt_prefix_hash !== guard.prefix,
		);
		const excluded = deps.bundle.items.length - eligible.length;
		const lines = eligible.map(exemplarLine).join("\n");
		try {
			const outcome = await callJev(deps.post, {
				body: jevRequestBody(deps.jevModel, input.state, lines),
				timeoutMs: childTimeoutMs(timeouts.jevMs),
				signal: deps.signal,
			});
			candidates["jev-all"] = {
				...outcome,
				latency_ms: now() - t0,
				excluded_exemplars: excluded,
				error: null,
			};
		} catch (err) {
			candidates["jev-all"] = failedCandidate(now() - t0, errorMessage(err), {
				excluded_exemplars: excluded,
			});
		}
	}

	async function runJevZeroShot(): Promise<void> {
		const t0 = now();
		try {
			const outcome = await callJev(deps.post, {
				body: jevZeroShotRequestBody(deps.jevModel, input.state),
				timeoutMs: childTimeoutMs(timeouts.jevMs),
				signal: deps.signal,
			});
			candidates["jev-zeroshot"] = {
				...outcome,
				latency_ms: now() - t0,
				error: null,
			};
		} catch (err) {
			candidates["jev-zeroshot"] = failedCandidate(
				now() - t0,
				errorMessage(err),
			);
		}
	}

	async function runEmbeddingDependents(): Promise<void> {
		const needsK24 = wanted.includes("jev-k24") || wanted.includes("flash-k24");
		if (!needsK24) return;
		const t0 = now();
		let query: number[];
		try {
			query = await fetchQueryEmbedding(deps.post, {
				view: contextView(input.state),
				timeoutMs: childTimeoutMs(timeouts.embedMs),
				signal: deps.signal,
			});
			embedding.latency_ms = now() - t0;
		} catch (err) {
			const message = errorMessage(err);
			embedding.error = message;
			if (wanted.includes("jev-k24")) {
				candidates["jev-k24"] = failedCandidate(now() - t0, message, {
					excluded_exemplars: countGuardExcluded(deps.bundle, guard),
				});
			}
			if (wanted.includes("flash-k24")) {
				candidates["flash-k24"] = failedCandidate(now() - t0, message);
			}
			return;
		}
		const top = topK(deps.bundle, query, k, guard);
		const keys = top.map((item) => item.key);

		const pending: Promise<void>[] = [];
		if (wanted.includes("jev-k24")) {
			const t1 = now();
			pending.push(
				callJev(deps.post, {
					body: jevRequestBody(
						deps.jevModel,
						input.state,
						top.map(exemplarLine).join("\n"),
					),
					timeoutMs: childTimeoutMs(timeouts.jevMs),
					signal: deps.signal,
				}).then(
					(outcome) => {
						candidates["jev-k24"] = {
							...outcome,
							latency_ms: now() - t1,
							excluded_exemplars: countGuardExcluded(deps.bundle, guard),
							exemplars: keys,
							error: null,
						};
					},
					(err) => {
						candidates["jev-k24"] = failedCandidate(
							now() - t1,
							errorMessage(err),
							{
								excluded_exemplars: countGuardExcluded(deps.bundle, guard),
								exemplars: keys,
							},
						);
					},
				),
			);
		}
		if (wanted.includes("flash-k24")) {
			const t1 = now();
			pending.push(
				callFlash(deps.post, {
					exemplars: top,
					conversation: input.state.conversation,
					timeoutMs: childTimeoutMs(timeouts.flashMs),
					signal: deps.signal,
				}).then(
					({ tier, input_tokens }) => {
						candidates["flash-k24"] = {
							tier,
							probs: null,
							tier_expected: null,
							confidence: null,
							latency_ms: now() - t1,
							input_tokens,
							cost: null,
							exemplars: keys,
							error: null,
						};
					},
					(err) => {
						candidates["flash-k24"] = failedCandidate(
							now() - t1,
							errorMessage(err),
							{
								exemplars: keys,
							},
						);
					},
				),
			);
		}
		await Promise.all(pending);
	}

	await Promise.all([
		wanted.includes("jev-all") ? runJevAll() : Promise.resolve(),
		wanted.includes("jev-zeroshot") ? runJevZeroShot() : Promise.resolve(),
		runEmbeddingDependents(),
	]);

	return { embedding, candidates };
}
