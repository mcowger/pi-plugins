/**
 * Exemplar bundle (REQUIREMENTS R7.5, R7.6, R7.10, R8).
 *
 * Ports of the experiment's bundle helpers: marker stripping + normalization
 * + hashing for the leakage guard, code-point-exact previews, exemplar lines,
 * and similarity top-K with a stable bundle-order tiebreak.
 *
 * Vectors stay float64 (plain `number[]`): the stored values are f64 and the
 * dot products then match the experiment bit-for-bit, keeping top-K order
 * identical.
 */

import { createHash } from "node:crypto";
import { scrubSecrets } from "./scrub.js";

export type Tier = "economy" | "standard" | "high" | "premium";

export const TIERS: Tier[] = ["economy", "standard", "high", "premium"];

export const TIER_RANK: Record<Tier, number> = {
	economy: 0,
	standard: 1,
	high: 2,
	premium: 3,
};

export function isTier(value: unknown): value is Tier {
	return (
		value === "economy" ||
		value === "standard" ||
		value === "high" ||
		value === "premium"
	);
}

export interface Exemplar {
	key: string;
	set: string;
	tier: Tier;
	preview: string;
	prompt_norm_hash: string;
	prompt_prefix_hash: string;
	vector: number[];
}

export interface Bundle {
	version: string;
	embedding_model: string;
	order: string;
	preview_chars: number;
	normalization: string;
	counts: Record<string, number>;
	items: Exemplar[];
}

export interface GuardHashes {
	/** sha256 of the normalized prompt. */
	full: string;
	/** sha256 of the first 200 code points of the normalized prompt. */
	prefix: string;
}

export const EMBEDDING_DIMENSIONS = 1536;
export const PREVIEW_CHARS = 240;
export const PREFIX_CHARS = 200;

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Remove trailing dataset image/truncation markers before hashing. */
function stripMarkers(prompt: string): string {
	const once = prompt.replace(/\s+$/, "").replace(/\n*\[Image[^\]]*\]\s*$/, "");
	return once
		.replace(/\s+$/, "")
		.replace(/\n*\[\.\.\.truncated[^\]]*\]\s*$/, "");
}

/** Collapse whitespace runs to one space, trim, lower-case. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** First `n` Unicode code points (mirrors the experiment's slicing). */
function firstCodePoints(text: string, n: number): string {
	const points = Array.from(text);
	return points.length <= n ? text : points.slice(0, n).join("");
}

/**
 * Leakage-guard hashes for the current prompt (R7.6): an exemplar is
 * excluded when either stored hash equals the matching hash here.
 */
export function guardHashesForPrompt(prompt: string): GuardHashes {
	const norm = normalize(stripMarkers(prompt));
	return {
		full: sha256Hex(norm),
		prefix: sha256Hex(firstCodePoints(norm, PREFIX_CHARS)),
	};
}

/** True when the exemplar must be excluded for this turn's guard. */
export function isGuardExcluded(
	exemplar: Pick<Exemplar, "prompt_norm_hash" | "prompt_prefix_hash">,
	guard: GuardHashes,
): boolean {
	return (
		exemplar.prompt_norm_hash === guard.full ||
		exemplar.prompt_prefix_hash === guard.prefix
	);
}

/** Exemplar line: `- [<tier>] <preview>` (R7.5). */
export function exemplarLine(
	exemplar: Pick<Exemplar, "tier" | "preview">,
): string {
	return `- [${exemplar.tier}] ${exemplar.preview}`;
}

/**
 * Bundle preview for a raw prompt: scrub, collapse, cap at 240 code points
 * plus `…`. Only used in tests — live questions use the shipped previews.
 */
export function makePreview(prompt: string): string {
	const collapsed = scrubSecrets(prompt).split(/\s+/).filter(Boolean).join(" ");
	if (Array.from(collapsed).length <= PREVIEW_CHARS) return collapsed;
	return `${firstCodePoints(collapsed, PREVIEW_CHARS)}…`;
}

/** L2-normalize a vector (zero vectors map to norm 1, like the experiment). */
export function unitNorm(vector: ArrayLike<number>): number[] {
	let sum = 0;
	for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
	const norm = Math.sqrt(sum) || 1;
	const out = new Array<number>(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
	return out;
}

function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) sum += a[i] * b[i];
	return sum;
}

/**
 * Top-`k` exemplars by cosine similarity (query is unit-normalized first),
 * highest first, leakage-guard exclusions applied. Ties keep bundle order:
 * the sort is stable and eligible items start in bundle order.
 */
export function topK(
	bundle: Bundle,
	query: ArrayLike<number>,
	k: number,
	guard: GuardHashes,
): Exemplar[] {
	const unit = unitNorm(query);
	const scored: { score: number; item: Exemplar }[] = [];
	for (const item of bundle.items) {
		if (isGuardExcluded(item, guard)) continue;
		scored.push({ score: dotProduct(unit, item.vector), item });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k).map(({ item }) => item);
}

/** Count guard exclusions without running the lookup (for logging). */
export function countGuardExcluded(bundle: Bundle, guard: GuardHashes): number {
	let excluded = 0;
	for (const item of bundle.items) {
		if (isGuardExcluded(item, guard)) excluded++;
	}
	return excluded;
}

/**
 * Load and validate the shipped bundle (R8.6). Throws on any shape failure;
 * the caller disables the extension with a single notify.
 */
export function loadBundle(data: unknown): Bundle {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("router-shadow: exemplar bundle is not an object");
	}
	const root = data as Record<string, unknown>;
	for (const field of [
		"version",
		"embedding_model",
		"order",
		"preview_chars",
		"normalization",
		"counts",
		"items",
	]) {
		if (!(field in root)) {
			throw new Error(`router-shadow: exemplar bundle missing ${field}`);
		}
	}
	if (!Array.isArray(root.items) || root.items.length === 0) {
		throw new Error("router-shadow: exemplar bundle has no items");
	}
	const items: Exemplar[] = root.items.map(
		(raw: unknown, index: number): Exemplar => {
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error(`router-shadow: exemplar ${index} is not an object`);
			}
			const item = raw as Record<string, unknown>;
			for (const field of [
				"key",
				"set",
				"tier",
				"preview",
				"prompt_norm_hash",
				"prompt_prefix_hash",
				"vector",
			]) {
				if (!(field in item)) {
					throw new Error(`router-shadow: exemplar ${index} missing ${field}`);
				}
			}
			if (!isTier(item.tier)) {
				throw new Error(`router-shadow: exemplar ${index} has bad tier`);
			}
			if (!Array.isArray(item.vector)) {
				throw new Error(`router-shadow: exemplar ${index} vector not an array`);
			}
			if (item.vector.length !== EMBEDDING_DIMENSIONS) {
				throw new Error(
					`router-shadow: exemplar ${index} vector has ${item.vector.length} dims, want ${EMBEDDING_DIMENSIONS}`,
				);
			}
			for (const value of item.vector) {
				if (typeof value !== "number" || !Number.isFinite(value)) {
					throw new Error(
						`router-shadow: exemplar ${index} vector has non-numeric entry`,
					);
				}
			}
			return {
				key: String(item.key),
				set: String(item.set),
				tier: item.tier,
				preview: String(item.preview),
				prompt_norm_hash: String(item.prompt_norm_hash),
				prompt_prefix_hash: String(item.prompt_prefix_hash),
				vector: (item.vector as number[]).slice(),
			};
		},
	);
	return Object.freeze({
		version: String(root.version),
		embedding_model: String(root.embedding_model),
		order: String(root.order),
		preview_chars: Number(root.preview_chars),
		normalization: String(root.normalization),
		counts: root.counts as Record<string, number>,
		items: Object.freeze(items) as Exemplar[],
	}) as Bundle;
}
