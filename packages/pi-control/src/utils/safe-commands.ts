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
	// File reading
	"cat *",
	"head *",
	"tail *",
	"less *",
	"more *",
	"strings *",
	"xxd *",
	"od *",

	// File metadata and navigation
	"ls *",
	"ls",
	"ll *",
	"ll",
	"la *",
	"la",
	"pwd",
	"stat *",
	"file *",
	"du *",
	"df *",
	"find *",

	// Search
	"grep *",
	"rg *",
	"ag *",
	"fgrep *",
	"egrep *",
	"ripgrep *",

	// Text processing (read-only usage — no -i flag, no redirect)
	"wc *",
	"sort *",
	"uniq *",
	"cut *",
	"tr *",
	"column *",
	"diff *",
	"comm *",

	// Structured data processing. Inline interpreters are intentionally excluded:
	// their source can perform arbitrary filesystem or process effects.
	"jq *",
	"yq *",

	// Git read-only
	"git status",
	"git status *",
	"git log *",
	"git log",
	"git diff *",
	"git diff",
	"git show *",
	"git branch *",
	"git branch",
	"git remote *",
	"git tag *",
	"git tag",
	"git stash list",
	"git stash show *",
	"git blame *",
	"git describe *",
	"git rev-parse *",
	"git ls-files *",
	"git ls-tree *",

	// System info (read-only)
	"echo *",
	"printf *",
	// `env` without arguments prints variables; with a command it executes it.
	"env",
	"printenv *",
	"printenv",
	"which *",
	"type *",
	"whereis *",
	"uname *",
	"hostname",
	"whoami",
	"id",
	"date",
	"date *",
	"uptime",
	"ps *",
	"ps",

	// Process / port inspection
	"lsof *",
	"netstat *",
	"ss *",

	// Package managers (list/info only)
	"npm list *",
	"npm outdated *",
	"npm info *",
	"npm view *",
	"pip list *",
	"pip show *",
	"pip freeze",
	"bun pm ls *",

	// Build tool info
	"make -n *",
	"make --dry-run *",
];
