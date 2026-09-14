import { findEnvKeys, getProviders, type KnownProvider } from "@earendil-works/pi-ai/compat";

const AMBIENT_CREDENTIAL_ENV_VARS: Record<string, readonly string[]> = {
	"amazon-bedrock": [
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
	],
	"google-vertex": [
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GOOGLE_APPLICATION_CREDENTIALS",
	],
};

function getProviderEnvVars(provider: KnownProvider): Set<string> {
	return new Set([...(findEnvKeys(provider) ?? []), ...(AMBIENT_CREDENTIAL_ENV_VARS[provider] ?? [])]);
}

/**
 * Delete credentials for providers not in the enabled list before Pi loads models.
 * Returns deleted variables so they can be restored while the agent runs.
 */
export function suppressProviderEnvVars(enabledProviders: string[]): Record<string, string> {
	const enabledSet = new Set(enabledProviders);
	const providerEnvVars = new Map<string, Set<string>>(
		getProviders().map((provider) => [provider, getProviderEnvVars(provider)]),
	);
	const enabledEnvVars = new Set(
		enabledProviders.flatMap((provider) => Array.from(providerEnvVars.get(provider) ?? [])),
	);
	const deleted: Record<string, string> = {};

	for (const [provider, envVars] of providerEnvVars) {
		if (enabledSet.has(provider)) continue;

		for (const envVar of envVars) {
			if (enabledEnvVars.has(envVar)) continue;

			const value = process.env[envVar];
			if (value) {
				deleted[envVar] = value;
				delete process.env[envVar];
			}
		}
	}

	return deleted;
}
