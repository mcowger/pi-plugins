import { existsSync } from "node:fs";
import { resolve } from "node:path";

// tests/utils → tests → packages/pi-control
const PACKAGE_ENV = resolve(import.meta.dir, "..", "..", ".env");

/**
 * Live tests need `OPENROUTER_API_KEY`. Prefer it from the ambient environment;
 * otherwise load a **package-local** `.env` (`packages/pi-control/.env`,
 * gitignored).
 *
 * Deliberately not the repo-root `.env`: Bun auto-loads that for every package's
 * test run, which breaks unrelated env-sensitive suites (e.g.
 * pi-suppress-providers). A package-local file only affects pi-control.
 *
 * Never logs the value; a missing file just leaves the key unset and the gated
 * suites skip.
 */
export function loadLiveEnv(key = "OPENROUTER_API_KEY"): void {
	if (process.env[key]) return;
	if (existsSync(PACKAGE_ENV)) process.loadEnvFile(PACKAGE_ENV);
}
