/**
 * Query embedding lookup (REQUIREMENTS R7.8–R7.11).
 */

import type { PostJson } from "../http.js";
import { unitNorm } from "../bundle.js";

export const EMBED_TIMEOUT_MS = 2000;
export const EMBED_MODEL = "text-embedding-3-small";

/** POST one context view, return the unit-normalized query vector. */
export async function fetchQueryEmbedding(
	post: PostJson,
	args: {
		view: string;
		model?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<number[]> {
	const { json } = await post(
		"/v1/embeddings",
		{ model: args.model ?? EMBED_MODEL, input: [args.view] },
		{
			timeoutMs: args.timeoutMs ?? EMBED_TIMEOUT_MS,
			abort: args.signal,
		},
	);
	if (json === null || typeof json !== "object" || Array.isArray(json)) {
		throw new Error("invalid_json: embedding response is not an object");
	}
	const data = (json as Record<string, unknown>).data;
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error("invalid_json: embedding response has no data");
	}
	const rows = data
		.map((row) => row as { index?: unknown; embedding?: unknown })
		.filter(
			(row) =>
				typeof row.index === "number" &&
				Array.isArray(row.embedding) &&
				row.embedding.every(
					(value) => typeof value === "number" && Number.isFinite(value),
				),
		)
		.sort((a, b) => (a.index as number) - (b.index as number));
	if (rows.length === 0) {
		throw new Error("invalid_json: embedding response has no usable rows");
	}
	return unitNorm(rows[0].embedding as number[]);
}
