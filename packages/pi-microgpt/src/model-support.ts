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
