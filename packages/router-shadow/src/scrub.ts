/**
 * Secret scrubbing (REQUIREMENTS R9).
 *
 * Exact port of the experiment's `scrub_prompt_secrets`: assignments first,
 * then Bearer, then known token prefixes. Applied to every message text,
 * tool name and tool-call argument string before any network call, and again
 * at the context-view boundary (which also covers tool names in state).
 *
 * The assignment scan is a hand-rolled loop, not `String.replace`, because
 * of the rescan rule (R9.1): when a match's name isn't secret, scanning
 * resumes at the start of its value so nested assignments aren't hidden.
 */

export const REDACTED = "[REDACTED]";

const SECRET_MARKERS = new Set([
	"API_KEY",
	"APIKEY",
	"ACCESS_TOKEN",
	"REFRESH_TOKEN",
	"AUTH_TOKEN",
	"ID_TOKEN",
	"CLIENT_SECRET",
	"CLIENTSECRET",
	"SECRET_KEY",
	"SECRETKEY",
	"SECRET",
	"TOKEN",
	"PASSWORD",
	"PASSWD",
	"PWD",
]);

// Mirrors `_SECRET_ASSIGN_RE` (no flags): name, separator, then a
// double-quoted, single-quoted or bare value.
const ASSIGN_RE =
	/(["']?[A-Za-z_][A-Za-z0-9_.\-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\n]+)/g;

// Mirrors `_BEARER_RE` (case-insensitive); the prefix is preserved verbatim.
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._-]+/gi;

// Mirrors `_TOKEN_PREFIX_RE` (case-insensitive).
const TOKEN_PREFIX_RE =
	/\b(?:sk-|ghp_|gho_|ghs_|GOCSPX-|github_pat_|cfut_|glpat-|xox[abpr]-|AKIA|sk_live_|rk_live_)[A-Za-z0-9_\-]+/gi;

/** True when a config key names secret material, matching whole segments. */
export function isSecretName(name: string): boolean {
	const normalized = name
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (SECRET_MARKERS.has(normalized)) return true;
	return normalized.split("_").some((segment) => SECRET_MARKERS.has(segment));
}

function redactValue(value: string): string {
	if (value.startsWith('"')) return `"${REDACTED}"`;
	if (value.startsWith("'")) return `'${REDACTED}'`;
	return REDACTED;
}

function scrubAssignments(text: string): string {
	let out = "";
	let pos = 0;
	ASSIGN_RE.lastIndex = 0;
	for (;;) {
		ASSIGN_RE.lastIndex = pos;
		const m = ASSIGN_RE.exec(text);
		if (!m) {
			out += text.slice(pos);
			break;
		}
		const name = m[1];
		const sep = m[2];
		const valueStart = m.index + name.length + sep.length;
		if (isSecretName(name)) {
			out += text.slice(pos, m.index) + name + sep + redactValue(m[3]);
			pos = m.index + m[0].length;
		} else {
			out += text.slice(pos, valueStart);
			pos = valueStart;
		}
	}
	ASSIGN_RE.lastIndex = 0;
	return out;
}

/** Replace config-assigned secret values and token formats with [REDACTED]. */
export function scrubSecrets(prompt: string): string {
	const text = String(prompt);
	const assigned = scrubAssignments(text);
	const bearer = assigned.replace(
		BEARER_RE,
		(_match, prefix: string) => `${prefix}${REDACTED}`,
	);
	return bearer.replace(TOKEN_PREFIX_RE, REDACTED);
}
