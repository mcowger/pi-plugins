import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSupportedModel } from "./model-support.ts";
import { installMultiAgentTools } from "./multiagents.ts";

export default function multiagentsExtension(pi: ExtensionAPI): void {
	installMultiAgentTools(pi, isSupportedModel);
}
