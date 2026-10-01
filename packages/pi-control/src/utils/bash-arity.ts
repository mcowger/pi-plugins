/**
 * Bash subcommand arity table for intelligent session-allow pattern suggestions.
 *
 * When a user chooses "Allow for session" for a bash command, this table
 * determines how many leading tokens define the "human-understandable
 * subcommand". The remaining tokens are replaced with `*`.
 *
 * Longest prefix wins: `npm run dev` matches `"npm run": 3` (→ `npm run dev*`)
 * rather than `"npm": 2` (→ `npm run*`).
 * Unknown commands default to arity 1 (first word only).
 *
 * To add an entry, place the most specific multi-word prefix first (longest
 * match, not insertion order).
 */

/** arity: number of leading tokens to keep verbatim before the `*`. */
const ARITY: Record<string, number> = {
	// Package managers
	"npm run": 3,
	"npm exec": 3,
	"yarn run": 3,
	"pnpm run": 3,
	"bun run": 3,
	npm: 2,
	yarn: 2,
	pnpm: 2,
	bun: 2,
	pip: 2,
	pip3: 2,

	// Version control — arity 2: just `git <subcommand> *`
	git: 2,

	// Container / orchestration
	"docker compose": 3,
	docker: 2,
	kubectl: 2,
	helm: 2,
	terraform: 2,

	// Build tools
	cargo: 2,
	go: 2,
	make: 2,
	cmake: 2,

	// System / admin — conservative: only first word (the command itself)
	rm: 1,
	cp: 2,
	mv: 2,
	mkdir: 1,
	cat: 1,
	ls: 1,
	find: 1,
	grep: 1,
	chmod: 1,
	chown: 1,
	sudo: 1,
	dd: 1,
	mount: 1,
	umount: 1,
	systemctl: 2,
	journalctl: 2,

	// Runtimes
	python: 1,
	python3: 1,
	node: 1,
	ruby: 1,
	perl: 1,
	php: 1,

	// Network / remote
	ssh: 1,
	scp: 1,
	rsync: 1,
	curl: 1,
	wget: 1,

	// GitHub CLI
	"gh pr": 3,
	"gh issue": 3,
	"gh release": 3,
	gh: 2,
};

/**
 * git global options that take their value in the following token
 * (`-C <path>`). `--opt=value` spellings are handled separately.
 */
const GIT_GLOBAL_VALUE_OPTS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);

/** git global options that stand alone (no following value). */
const GIT_GLOBAL_FLAG_OPTS = new Set([
	"-p",
	"--paginate",
	"--no-pager",
	"--bare",
	"--no-replace-objects",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
]);

/** `--opt=value` spellings of git global options. */
const GIT_GLOBAL_PREFIX_OPTS = [
	"--git-dir=",
	"--work-tree=",
	"--namespace=",
	"--exec-path=",
	"--config-env=",
];

/**
 * Drop git's global options so the subcommand sits directly after `git`.
 *
 *   `git -C /repo status --short` → `["git", "status", "--short"]`
 *   `git --git-dir=/repo/.git log` → `["git", "log"]`
 *
 * Non-git commands, and git commands whose first token after `git` is not a
 * recognized global option, are returned unchanged. `git -C <path>` is the
 * important case: without this, the subcommand is mistaken for the path and
 * the session pattern collapses to `git -C *`.
 */
function stripGitGlobalOptions(tokens: string[]): string[] {
	if (tokens[0] !== "git") return tokens;
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];
		const isAttachedShort = /^-[Cc]./.test(token); // -C/path, -cname=value
		const isValueOpt = GIT_GLOBAL_VALUE_OPTS.has(token);
		const isFlagOpt = GIT_GLOBAL_FLAG_OPTS.has(token);
		const isPrefixOpt = GIT_GLOBAL_PREFIX_OPTS.some((p) => token.startsWith(p));
		if (isValueOpt) {
			i += 2;
			continue;
		}
		if (isFlagOpt || isAttachedShort || isPrefixOpt) {
			i += 1;
			continue;
		}
		break;
	}
	return [tokens[0], ...tokens.slice(i)];
}

/**
 * Normalize a bash command for pattern matching by removing git's global
 * options, so a rule like `git status *` also matches
 * `git -C /repo status --short`. Returns the original string unchanged when
 * there is nothing to strip.
 */
export function normalizeCommand(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return command;
	const tokens = trimmed.split(/\s+/);
	const stripped = stripGitGlobalOptions(tokens);
	if (stripped.length === tokens.length) return command;
	return stripped.join(" ");
}

/**
 * Build a human-friendly session-allow pattern for a bash command.
 *
 * Uses the arity table to decide how many leading tokens to keep verbatim;
 * appends ` *` so subsequent similar commands (same subcommand, different
 * arguments / paths) match without re-prompting.
 *
 * Examples:
 *   `git commit -m "fix"`   → `git commit *`
 *   `git -C /repo status`    → `git status*`
 *   `npm install lodash`     → `npm install *`
 *   `npm run dev`            → `npm run dev*`
 *   `docker compose up`      → `docker compose up *`
 *   `rm -rf node_modules`    → `rm *`
 *   `mytool --verbose`       → `mytool *`
 */
export function suggestSessionPattern(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "*";

	const tokens = stripGitGlobalOptions(trimmed.split(/\s+/));

	let bestArity = 1; // default: first word only
	let bestKey = "";

	for (const [key, arity] of Object.entries(ARITY)) {
		const keyTokens = key.split(/\s+/);
		if (keyTokens.length > tokens.length) continue;
		if (keyTokens.every((t, i) => tokens[i] === t)) {
			// Longest prefix match
			if (key.length > bestKey.length) {
				bestArity = arity;
				bestKey = key;
			}
		}
	}

	// Clamp arity: can't keep more tokens than the command has.
	const clamped = Math.min(bestArity, tokens.length);
	const kept = tokens.slice(0, clamped).join(" ");

	// If the arity covers all tokens, append `*` directly (no space)
	// so patterns like `npm run dev*` match both bare `npm run dev` and
	// `npm run dev --flag`.
	if (clamped >= tokens.length) {
		return `${kept}*`;
	}
	return `${kept} *`;
}
