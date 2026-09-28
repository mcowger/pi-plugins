/**
 * Curated list of bash command glob patterns that are considered read-only /
 * non-mutating. Intended for use in "readonly" policies where the agent should
 * be able to inspect but not change anything.
 *
 * Each entry is a pattern suitable for a rule with action "allow" and
 * tool "bash". Patterns use * to match any arguments.
 *
 * This list is intentionally conservative. Commands that can mutate files
 * with certain flags (e.g. sed -i, awk with output redirection) are excluded
 * even though they are sometimes used read-only.
 */
export const SAFE_BASH_PATTERNS: string[] = [
	// File reading (bare form reads stdin — e.g. `| head` — still read-only)
	"cat *",
	"cat",
	"head *",
	"head",
	"tail *",
	"tail",
	"less *",
	"less",
	"more *",
	"more",
	"strings *",
	"strings",
	"xxd *",
	"xxd",
	"od *",
	"od",

	// File metadata and navigation (bare form either errors or reads — never writes)
	"ls *",
	"ls",
	"ll *",
	"ll",
	"la *",
	"la",
	"pwd",
	"stat *",
	"stat",
	"file *",
	"file",
	"du *",
	"du",
	"df *",
	"df",
	"find *",
	"find",

	// Search (bare form reads stdin — still read-only)
	"grep *",
	"grep",
	"rg *",
	"rg",
	"ag *",
	"ag",
	"fgrep *",
	"fgrep",
	"egrep *",
	"egrep",
	"ripgrep *",
	"ripgrep",

	// Text processing (read-only usage — no -i flag, no redirect;
	// bare form reads stdin — still read-only)
	"wc *",
	"wc",
	"sort *",
	"sort",
	"uniq *",
	"uniq",
	"cut *",
	"cut",
	"tr *",
	"tr",
	"column *",
	"column",
	"diff *",
	"diff",
	"comm *",
	"comm",

	// Structured data processing. Inline interpreters are intentionally excluded:
	// their source can perform arbitrary filesystem or process effects.
	// (bare form errors without a filter — never writes)
	"jq *",
	"jq",
	"yq *",
	"yq",

	// Git read-only (bare forms either list or error — never mutate)
	"git status",
	"git status *",
	"git log *",
	"git log",
	"git diff *",
	"git diff",
	"git show *",
	"git show",
	"git branch *",
	"git branch",
	"git remote *",
	"git remote",
	"git tag *",
	"git tag",
	"git stash list",
	"git stash show *",
	"git stash show",
	"git blame *",
	"git blame",
	"git describe *",
	"git describe",
	"git rev-parse *",
	"git rev-parse",
	"git ls-files *",
	"git ls-files",
	"git ls-tree *",
	"git ls-tree",

	// System info (read-only; bare form prints a line or errors — never writes).
	// hostname/whoami/id/uptime stay bare-only: extra args can set state
	// (hostname) or query other users, so they are not blanket-allowed.
	"echo *",
	"echo",
	"printf *",
	"printf",
	// `env` without arguments prints variables; with a command it executes it.
	"env",
	"printenv *",
	"printenv",
	"which *",
	"which",
	"type *",
	"type",
	"whereis *",
	"whereis",
	"uname *",
	"uname",
	"hostname",
	"whoami",
	"id",
	"date",
	"date *",
	"uptime",
	"ps *",
	"ps",

	// Process / port inspection (bare form lists — still read-only)
	"lsof *",
	"lsof",
	"netstat *",
	"netstat",
	"ss *",
	"ss",

	// Package managers (list/info only; bare form lists — still read-only)
	"npm list *",
	"npm list",
	"npm outdated *",
	"npm outdated",
	"npm info *",
	"npm info",
	"npm view *",
	"npm view",
	"pip list *",
	"pip list",
	"pip show *",
	"pip show",
	"pip freeze",
	"bun pm ls *",
	"bun pm ls",

	// Build tool info (dry-run prints without executing)
	"make -n *",
	"make -n",
	"make --dry-run *",
	"make --dry-run",
];
