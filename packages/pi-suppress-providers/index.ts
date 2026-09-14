import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { suppressProviderEnvVars } from "./src/provider-env.js";
import { readEnabledProviders } from "./src/settings.js";

const enabledProviders = readEnabledProviders();
const savedEnv = enabledProviders && enabledProviders.length > 0 ? suppressProviderEnvVars(enabledProviders) : {};

export default function suppressProvidersExtension(pi: ExtensionAPI) {
	if (Object.keys(savedEnv).length === 0) return;

	// Restore env vars only while the agent is running so tool calls can use them,
	// then re-suppress so the model picker stays clean between turns.
	pi.on("before_agent_start", () => {
		for (const [key, value] of Object.entries(savedEnv)) {
			process.env[key] = value;
		}
	});

	pi.on("agent_end", () => {
		for (const key of Object.keys(savedEnv)) {
			delete process.env[key];
		}
	});
}
