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
 * Build a human-friendly session-allow pattern for a bash command.
 *
 * Uses the arity table to decide how many leading tokens to keep verbatim;
 * appends ` *` so subsequent similar commands (same subcommand, different
 * arguments / paths) match without re-prompting.
 *
 * Examples:
 *   `git commit -m "fix"`   → `git commit *`
 *   `npm install lodash`     → `npm install *`
 *   `npm run dev`            → `npm run dev*`
 *   `docker compose up`      → `docker compose up *`
 *   `rm -rf node_modules`    → `rm *`
 *   `mytool --verbose`       → `mytool *`
 */
export function suggestSessionPattern(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "*";

	const tokens = trimmed.split(/\s+/);

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
