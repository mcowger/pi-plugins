import type { Api, Model } from "@earendil-works/pi-ai";

export const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);
export const SUPPORTED_MODEL_SLUG = /^gpt-(?:5\.(?:[5-9]|\d{2,})|[6-9]\d*(?:\.\d+)?)(?:[-_.]|$)/i;

export type PiModel = Model<Api>;

export function isResponsesModel(model: PiModel | undefined): model is PiModel {
	return model !== undefined && RESPONSES_APIS.has(model.api);
}

export function isSupportedModel(model: PiModel | undefined): model is PiModel {
	return model !== undefined && isResponsesModel(model) && SUPPORTED_MODEL_SLUG.test(model.id);
}

// Canonical flex-SKU model families from OpenAI's Flex processing docs and
// pricing page. `gpt-5` covers gpt-5-mini/gpt-5-nano via the matcher below;
// `o3`/`o4-mini` document flex support but sit outside this plugin's GPT-5.5+
// scope, so isFlexSupportedModel still excludes them (see below).
export const FLEX_SUPPORTED_MODEL_SLUGS = [
	"gpt-6-astra",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"o3",
	"o4-mini",
] as const;

function flexSlugMatches(id: string): boolean {
	// gpt-5 family (incl. mini/nano/snapshot suffixes); the separator class
	// deliberately excludes "." so the dotted gpt-5.x line never matches here.
	if (/^gpt-5(?:$|[-_])/i.test(id)) return true;
	// o3 snapshots; excludes the o3-mini line, which has no flex support.
	if (/^o3(?:$|[-_.](?!mini(?:$|[-_.])))/i.test(id)) return true;
	const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const suffixed = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5-mini", "gpt-5-nano", "o4-mini"] as const;
	return suffixed.some((base) => new RegExp(`^${escaped(base)}(?:$|[-_.])`, "i").test(id));
}

// Flex is a subset of plugin support: the model must pass the shared GPT-5.5+
// Responses API check AND belong to OpenAI's flex SKU. Within current plugin
// scope this means gpt-6-astra and gpt-5.6 sol/terra/luna (plus snapshots).
export function isFlexSupportedModel(model: PiModel | undefined): model is PiModel {
	return isSupportedModel(model) && flexSlugMatches(model.id);
}
