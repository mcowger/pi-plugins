/**
 * Origin tagging, ack detection and model→tier mapping (R4.5, R5).
 */

import { type Tier, isTier } from "./bundle.js";
import { utf16Len } from "./context/utf16.js";

export type Origin = "human" | "subagent" | "extension" | "unknown";
export type ActualSource = "user_selection" | "subagent_config" | "unknown";

const ACK_PATTERN =
	/^(ok|okay|k|thanks|thank you|thx|yes|yep|yeah|sure|go on|go ahead|continue|please continue|keep going|got it|sounds good|great|do it|cool|nice|perfect)\b/i;
const TRAILING_PUNCT = /[.!?,;:'"]+$/;

const SUBAGENT_PATTERNS = [
	/you are a delegated subagent/i,
	/task:\s*you are/i,
	/message\s*type:\s*new_task/i,
];

const SKILL_PATTERN = /^\s*<skill name="([^"]+)"/;

/** Mirror the experiment's `is_acknowledgement` (R4.5). */
export function isAck(prompt: string): boolean {
	const stripped = String(prompt)
		.trim()
		.toLowerCase()
		.replace(TRAILING_PUNCT, "");
	const normalized = stripped.replace(/\s+/g, " ");
	return (
		normalized.length > 0 &&
		utf16Len(normalized) <= 40 &&
		ACK_PATTERN.test(normalized)
	);
}

export interface OriginSignals {
	isSubagentSession: boolean;
	/** Last `input` event source, when observed. */
	inputSource?: "interactive" | "rpc" | "extension" | string;
}

export interface OriginResult {
	origin: Origin;
	skill_name: string | null;
}

/** Classify who wrote the prompt (R5.2). */
export function classifyOrigin(
	prompt: string,
	signals: OriginSignals,
): OriginResult {
	const skillMatch = SKILL_PATTERN.exec(prompt);
	const skill_name = skillMatch ? skillMatch[1] : null;
	const text = String(prompt);
	const looksDelegated =
		signals.isSubagentSession ||
		skill_name !== null ||
		SUBAGENT_PATTERNS.some((pattern) => pattern.test(text));
	if (looksDelegated) return { origin: "subagent", skill_name };
	if (signals.inputSource === "extension")
		return { origin: "extension", skill_name };
	if (signals.inputSource === "interactive" || signals.inputSource === "rpc")
		return { origin: "human", skill_name };
	return { origin: "unknown", skill_name };
}

/** Classify where the running model came from (R5.3). */
export function classifyActualSource(
	isSubagentSession: boolean,
	origin: Origin,
	branchHasModelChange: boolean,
): ActualSource {
	if (isSubagentSession) return "subagent_config";
	if (origin === "human" && branchHasModelChange) return "user_selection";
	return "unknown";
}

export type TierMap = Map<string, Tier>;

/** Build the alias/synonym → tier lookup from `models.json` (R10.4). */
export function buildTierMap(modelsData: unknown): TierMap {
	const map: TierMap = new Map();
	if (modelsData === null || typeof modelsData !== "object") return map;
	const tiers = (modelsData as Record<string, unknown>).tiers;
	if (tiers === null || typeof tiers !== "object") return map;
	for (const [tier, entry] of Object.entries(
		tiers as Record<string, unknown>,
	)) {
		if (!isTier(tier)) continue;
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const names = [
			record.alias,
			...(Array.isArray(record.synonyms) ? record.synonyms : []),
		];
		for (const name of names) {
			if (typeof name === "string" && name) {
				map.set(name.toLowerCase(), tier);
			}
		}
	}
	return map;
}

/** Map a model id to its tier via alias or synonym; null when unknown. */
export function mapModelToTier(
	modelId: string | undefined,
	tierMap: TierMap,
): Tier | null {
	if (!modelId) return null;
	return tierMap.get(modelId.toLowerCase()) ?? null;
}
