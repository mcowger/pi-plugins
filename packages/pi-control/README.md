# pi-control


A [pi](https://github.com/earendil-works/pi) extension that enforces action-based policies on tool calls, scoped by filesystem location.

When the agent tries to run a bash command, read a file, write to a path, or call any other tool, pi-controls checks which policy governs that location and either allows, nudges, logs, asks for confirmation, or denies the call — before execution.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Config File Locations](#config-file-locations)
- [Core Concepts](#core-concepts)
  - [Policies](#policies)
  - [Rules](#rules)
  - [Actions](#actions)
  - [Agent Timeout](#agent-timeout)
  - [Nudge Timeout](#nudge-timeout)
  - [Locations](#locations)
- [Rule Matching and Specificity](#rule-matching-and-specificity)
- [Multi-Target Resolution](#multi-target-resolution)
- [Bash Command Parsing](#bash-command-parsing)
- [Safe Command Patterns](#safe-command-patterns)
- [Examples](#examples)
  - [Protect production configs](#protect-production-configs)
  - [Audit-only mode](#audit-only-mode)
  - [Interactive gate on destructive commands](#interactive-gate-on-destructive-commands)
  - [Allow git, block everything else](#allow-git-block-everything-else)
  - [GitHub tool lockdown](#github-tool-lockdown)
  - [Per-project policy with global fallback](#per-project-policy-with-global-fallback)
  - [Layered home and project policies](#layered-home-and-project-policies)
  - [Redirect-aware bash policies](#redirect-aware-bash-policies)
  - [Mixed restrictiveness across pipeline stages](#mixed-restrictiveness-across-pipeline-stages)
  - [Nudge toward better tools](#nudge-toward-better-tools)
  - [Nudge timeout — escalating ignored nudges](#nudge-timeout--escalating-ignored-nudges)
  - [Agent timeout as a safety net](#agent-timeout-as-a-safety-net)
- [Config Reference](#config-reference)
- [Development](#development)

---

## Installation

pi-controls is published to npm and installed via pi's built-in package manager.

### Global install (all projects)

```sh
pi install npm:@mcowger/pi-control
```

The extension is active in every pi session.

### Project-local install

```sh
pi install npm:@mcowger/pi-control -l
```

This records the package in `.pi/settings.json` in the current directory. Only active when pi runs from that project.

### Pinning to a specific version

Append `@<version>` to pin a published version. Pinned packages are excluded from `pi update`.

```sh
pi install npm:@mcowger/pi-control@1.0.0
```

Git sources can also be pinned to a tag, branch, or commit when testing unreleased changes:

```sh
pi install ./pi-plugins/packages/pi-control
```

### Updating

```sh
pi update                         # update all packages
pi update npm:@mcowger/pi-control  # update this package only
```

### Removing

```sh
pi remove npm:@mcowger/pi-control
pi remove npm:@mcowger/pi-control -l      # project-local
```

---

## Behavior With No Config

If no config file is found at startup, pi-controls fails open — all tool calls proceed unrestricted. A warning notification is shown in the pi UI to make clear the extension is active but unconfigured:

> `[pi-controls] No config found — all tool calls are unrestricted. Create ~/.pi/agent/extensions/pi-controls.jsonc to enforce policies.`

The startup entry in `~/.pi/agent/extensions/pi-controls.log` will show `loaded: 0 policies, 0 locations, defaultPolicy=null`.

---

## Quick Start

Create `~/.pi/agent/extensions/pi-controls.json`:

```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "strict"
  }
}
```

Any tool call made while the agent's target is inside `/home/user/work` now follows the `strict` policy. Reads are allowed, git commands are allowed (pushes need confirmation), `rm` is denied, and everything else is denied by the `defaultAction`.

---

## Config File Locations

pi-controls loads config from two places and deep-merges them. **Project-local wins on conflict.**

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-controls.jsonc` |
| Project-local | `.pi/extensions/pi-controls.jsonc` (walks up from CWD) |

Config files use **JSONC** (JSON with Comments), so `//` and `/* */` comments are supported. Plain `.json` is also accepted as a fallback.

See [`examples/sample.jsonc`](examples/sample.jsonc) for a fully annotated starting point.

This means you can define your base policies globally and override or extend them per project.

**Global** (`~/.pi/agent/extensions/pi-controls.jsonc`):
```json
{
  "policies": {
    "default": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user": "default"
  }
}
```

**Project-local** (`.pi/extensions/pi-controls.jsonc` at project root):
```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" }
      ]
    }
  },
  "locations": {
    "/home/user/work/myproject": "strict"
  }
}
```

At runtime both `default` and `strict` are available. `/home/user/work/myproject` uses `strict`; the rest of `/home/user` uses `default`.

---

## Core Concepts

### Policies

A **policy** is a named set of rules with a `defaultAction` that applies when no rule matches.

```json
{
  "policies": {
    "my-policy": {
      "defaultAction": "deny",
      "rules": [ ... ]
    }
  }
}
```

Policies are referenced by name from `locations`. You can define as many as you need — one per project, one per risk tier, etc.

### Rules

Each rule has:

| Field | Required | Description |
|-------|----------|-------------|
| `action` | always | `"allow"`, `"nudge"`, `"ask"`, `"deny"`, or `"log"` |
| `tool` | always | Tool name or glob (e.g. `"bash"`, `"github_*"`, `"*"`) |
| `pattern` | bash only | Glob matched against the full command string |
| `message` | nudge only | Reminder injected into the tool result when action is `"nudge"` |

`pattern` is only evaluated when `tool` is `"bash"`. For all other tools, the location boundary is the only scope — no pattern is needed or used.

`message` is required when `action` is `"nudge"` and ignored for all other actions.

```json
{ "action": "allow", "tool": "read" }
{ "action": "nudge", "tool": "read",  "message": "Prefer pluck_read for repo files." }
{ "action": "deny",  "tool": "write" }
{ "action": "ask",   "tool": "bash", "pattern": "git push *" }
{ "action": "log",   "tool": "github_*" }
{ "action": "deny",  "tool": "*" }
```

### Actions

| Action | Behavior |
|--------|----------|
| `allow` | Silent permit. Tool call proceeds with no interruption. |
| `nudge` | Tool call proceeds, **and** the `message` is prepended to the tool result so the LLM sees it before any output. A warning is also shown in the pi UI. Use this to guide the agent toward better alternatives without blocking it. Pair with `nudgeTimeout` to auto-escalate to `deny` when the agent repeatedly ignores the hint. |
| `log` | Tool call proceeds, but a notification is shown in the pi UI. Useful for auditing. |
| `ask` | Execution pauses and pi asks for confirmation. Approved → proceeds. Denied → blocked, and the LLM receives a reason message. |
| `deny` | Tool call is blocked immediately. The LLM receives a reason message. |

`defaultAction` follows the same behaviors and is used when no rule in the policy matches the current tool call. `"nudge"` is not valid as a `defaultAction` — it requires a `message` field which only makes sense on explicit rules.

### Agent Timeout

The **agent timeout** is a sliding-window circuit breaker. When an agent accumulates too many denied tool calls in a short period — a sign it may be going rogue — the next denied call is automatically escalated from a silent `deny` to an interactive `ask`. This gives you a chance to step in and redirect the agent rather than letting it spin against a wall of blocks.

```jsonc
{
  "agentTimeout": {
    "maxDenies": 3,      // trigger after this many denies…
    "windowSeconds": 60  // …within this rolling window
  }
}
```

**How it works:**

- Every time a tool call results in `deny`, the event is recorded with a timestamp.
- Before executing the deny, pi-controls checks whether the count of deny events within the last `windowSeconds` seconds has reached `maxDenies`.
- If yes, the action is escalated to `ask`: a confirmation dialog appears so you can approve the call, redirect the agent, or block it manually.
- The window is **sliding** — old events age out automatically. No explicit reset is needed; the circuit breaker naturally disarms once the deny rate drops.
- Escalation continues on every subsequent denied call until the window empties.

**Escalation note:** the `ask` dialog shown during escalation is the standard pi confirmation prompt. If you approve, the tool call proceeds. If you deny it, the agent receives a block message just as it would from a normal `deny`.

`agentTimeout` is optional. If absent or `null`, no escalation happens and all denies remain silent.

---

### Nudge Timeout

The **nudge timeout** is a per-rule sliding-window circuit breaker. When the agent ignores a nudge for the same rule too many times in a short period, the next occurrence is escalated from a soft `nudge` to a hard `deny`. The deny reason includes the original nudge message so the LLM knows exactly what it kept ignoring, plus an explicit instruction to change approach. After escalation the per-rule counter resets, giving the agent a chance to recover.

```jsonc
{
  "nudgeTimeout": {
    "maxNudges": 3,      // escalate after this many ignored nudges for the same rule…
    "windowSeconds": 60  // …within this rolling window
  }
}
```

**How it works:**

- Each nudge rule has its own sliding-window counter, keyed by tool name (for non-bash rules) or `tool:pattern` (for bash rules). `read` and `grep` nudges are tracked independently; `cat *` and `grep *` bash nudges are tracked independently.
- Every time a nudge fires for a rule, its counter is incremented.
- When the count within `windowSeconds` reaches `maxNudges`, the call is hard-denied instead of nudged. The deny reason contains the original nudge message and the text: *"You MUST switch approach now."*
- The per-rule counter **resets** after escalation. The agent gets another `maxNudges` chances before the next deny, rather than being permanently locked out.
- The window is **sliding** — old nudge events age out automatically.

**Example escalation sequence** with `maxNudges: 3`:

| Call # | Action |
|--------|--------|
| 1st `read` | nudge — reminder injected, tool proceeds |
| 2nd `read` | nudge — reminder injected, tool proceeds |
| 3rd `read` | **deny** — hard block with strong message, counter resets |
| 4th `read` | nudge — counter was reset, cycle starts over |

`nudgeTimeout` is optional. If absent or `null`, nudges never escalate.

---

### Feedback Messages

When pi-controls acts on a tool call, it shows a notification in the pi UI and (for deny/ask) sends a reason message to the LLM.

**Nudge (single line, tool proceeds):**
```
pi-controls: nudge [policy] — Prefer pluck_read for repo files — outline mode + semantic context.
```

**Log (tool proceeds, audited):**
```
pi-controls: log [policy]: write — path: "/home/user/project/src/main.ts"
```

**Ask (confirmation prompt shown to user):**
```
pi-controls: ask [policy]: bash — git push origin main
```

**Deny (bash with pattern match):**
```
pi-controls: deny [policy]: bash (git commit -m "...") — pattern: "git commit *"
```
LLM receives: `Access denied by policy: bash (...) — pattern: "git commit *". Avoid the blocked pattern in any retry.`

**Deny (non-bash tool or path restriction):**
```
pi-controls: deny [policy]: write — blocked path: "/etc/secrets"
```
LLM receives: `Access denied by policy: write — blocked path: "/etc/secrets". The restriction is on the PATH — not on the tool. Do NOT retry with a different tool.`

**Inform mode (would-block preview, nothing actually blocked):**
```
pi-controls: would-deny [policy]: git commit -m "..." — pattern: "git commit *"
```

Path labels in notifications:
- **`blocked path`** — only on `deny`, where the path is genuinely inaccessible
- **`path`** — on `log` and `ask`, where the call is still proceeding or pending approval

### Locations

A **location** maps a filesystem path to a policy name. The most specific (longest) matching path wins.

```json
{
  "locations": {
    "/home/user/work/secret-project": "strict",
    "/home/user/work":                "relaxed",
    "/home/user":                     "permissive"
  }
}
```

A tool call targeting `/home/user/work/secret-project/src/main.ts` matches all three locations, but `/home/user/work/secret-project` is longest, so `strict` applies.

The special key `"$cwd"` resolves dynamically to whatever directory pi was started from:

```jsonc
{
  "locations": {
    "$cwd": "strict",  // matches the directory pi was launched in
    "/tmp": "open"
  }
}
```

**Fallback:** if no location matches, the global `defaultPolicy` is used. If that is also unset (or `null`), the call proceeds unrestricted (fail-open).

```json
{
  "defaultPolicy": "relaxed"
}
```

---

## Rule Matching and Specificity

Rules within a policy do not have an explicit order. Instead, pi-controls scores each matching rule by **specificity** and picks the winner automatically.

**Specificity = number of literal characters before the first wildcard.**

| Pattern | Score |
|---------|-------|
| `"git commit *"` | 11 |
| `"git *"` | 4 |
| `"*"` | 0 |
| `"github_create_pull_request"` | 26 (no wildcard) |
| `"github_*"` | 7 |

**Example:** given these two rules in the same policy:

```json
{ "action": "allow", "tool": "bash", "pattern": "git *" },
{ "action": "ask",   "tool": "bash", "pattern": "git commit *" }
```

Running `git commit -m "fix"`:
- Both patterns match.
- `"git commit *"` scores 11, `"git *"` scores 4.
- Score 11 wins → **ask**.

Running `git status`:
- Only `"git *"` matches (score 4).
- Result → **allow**.

**Tiebreaker:** when two rules have the same specificity score, the least-disruptive action wins: `allow > nudge > ask > deny > log`. You never accidentally block something more than the rules intend.

```json
{ "action": "allow", "tool": "bash", "pattern": "git *" },
{ "action": "deny",  "tool": "bash", "pattern": "git *" }
```

Both score 4. Tiebreaker: **allow** wins.

```json
{ "action": "nudge", "tool": "bash", "pattern": "grep *", "message": "prefer rg" },
{ "action": "deny",  "tool": "bash", "pattern": "grep *" }
```

Both score 5. Tiebreaker: **nudge** wins (less disruptive than deny).

---

## Multi-Target Resolution

When a bash command touches files in multiple locations — through redirect targets — each location's policy is evaluated independently. The **most restrictive** action across all of them wins.

Restrictiveness order: `deny > ask > log > nudge > allow`

**Example config:**

```json
{
  "policies": {
    "strict":  { "defaultAction": "deny",  "rules": [] },
    "relaxed": { "defaultAction": "allow", "rules": [] }
  },
  "locations": {
    "/home/user/project": "strict",
    "/tmp":               "relaxed"
  }
}
```

**Command:** `cat /home/user/project/secrets.txt > /tmp/out.txt`

- The redirect target `/tmp/out.txt` → `relaxed` → **allow**
- The source file `/home/user/project/secrets.txt` → `strict` → **deny**
- Most restrictive: **deny**

Even though `/tmp` is relaxed, the fact that the command touches a strict location locks the whole operation.

---

## Bash Command Parsing

Bash, Python, JavaScript, and TypeScript are parsed with the prebuilt Tree-sitter WASM grammars distributed by [`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm).

From each shell stage, pi-controls extracts:

- **Command name + arguments** — used for pattern matching against bash rules
- **File redirect targets** — paths like `> /tmp/out.txt` or `>> log.txt` checked against location policies
- **fd-to-fd redirects** like `2>&1` — recognized and skipped because they do not target files
- **Heredoc and here-string source** — associated with interpreter invocations when static
- **Inline interpreter source** — Python `-c`, Node `-e`/`--eval`/`-p`, and Bun `-e`/`--eval`

Each pipeline or logical stage (`|`, `&&`, `;`) is evaluated independently. The most restrictive action across all stages and discovered targets wins.

### Interpreter source analysis

Source supplied to Python, Node, or Bun is inspected for common filesystem operations. Literal paths are fed into the same location and path-protection checks as ordinary Bash arguments. Static `env`, `bash -c`, and `sh -c` wrappers are unwrapped recursively.

Examples detected by this layer include:

```bash
python3 - <<'PY'
from pathlib import Path
Path("/outside/project/out.txt").write_text("data")
PY

node -e 'require("fs").writeFileSync("/outside/project/out.txt", "data")'
bun -e 'const p: string = "/outside/project/out.txt"; Bun.write(p, "data")'
```

Runtime-provided pure helpers are recognized without treating them as third-party code: this includes common Python standard-library utilities such as `re`, `io.StringIO`, `json`, and string transformations, plus selected Node and Bun runtime helpers. Broader runtime modules are not blanket exemptions: known filesystem and process operations (for example `os.replace`, `io.open`, Node `fs.open`, `child_process`, and `Bun.spawn`) are still detected and sent through policy evaluation. Static `.json` loads are reported as reads rather than as unanalyzed-module warnings.

When a Bash call resolves entirely to allow rules that already set `"allowUnanalyzed": true`, the unknown-action fallback is skipped: the trust decision has already been made, so no confirmation prompt appears. Other layers (path protection, location policy) still apply.

Interpreter fallbacks now offer an extra **Trust this pattern** choice. It writes a global allow rule with `allowUnanalyzed: true` for the matched command pattern, so future identical calls proceed without a prompt. Persistent policy, project, and trust selections are scoped to the resolved policy; multi-policy calls show a follow-up selector.

Analysis is deliberately conservative. Dynamic paths, unknown calls, unknown imports, subprocess execution, `eval`, parser errors, script files, unavailable standard-input source, and exceeded resource limits produce the configured `unknownAction`. The default is `ask`; if no approval is available, the call is blocked. Set it to `deny` for unattended environments.

When you explicitly trust a narrow class of unanalyzed interpreter invocations, add `"allowUnanalyzed": true` to its matching `allow` Bash rule. This bypasses only the interpreter-analysis fallback for that rule; normal rule matching and cross-cutting path protection still apply. For example, to trust package scripts while keeping direct Bun script files subject to analysis:

```json
{
  "action": "allow",
  "tool": "bash",
  "pattern": "bun run*",
  "allowUnanalyzed": true
}
```

Simple source whose calls and effects are fully understood remains silent under an allowing policy, for example `python3 -c 'print(1)'` or `node -e 'console.log("ok")'`.

This is static policy analysis, not an execution sandbox. Code can be arbitrarily dynamic, so unsupported or ambiguous constructs are never treated as proof of safety.

**If Tree-sitter fails to load**, pi-controls falls back to an incomplete tokenizer. Ordinary commands still use CWD policy evaluation, while interpreter-shaped input is treated conservatively rather than failing open.

---

## Safe Command Patterns

pi-controls ships a built-in preset, `"$safe-bash"`, that expands to ~90 allow rules for non-mutating bash commands. Use it anywhere in a `rules` array instead of listing the patterns by hand.

The preset covers:

| Category | Examples |
|----------|----------|
| File reading | `cat *`, `head *`, `tail *`, `xxd *` |
| File metadata | `ls *`, `stat *`, `du *`, `df *`, `find *` |
| Search | `grep *`, `rg *`, `ag *` |
| Text processing | `wc *`, `sort *`, `diff *`, `jq *`, `yq *` |
| Git (read-only) | `git status`, `git log *`, `git diff *`, `git blame *` |
| System info | `echo *`, `env`, `which *`, `ps *`, `uname *` |
| Package info | `npm list *`, `pip show *`, `bun pm ls *` |

The list is intentionally conservative. Commands that can mutate files under certain flags (e.g. `sed -i`, `awk` with output redirection) are excluded.

### Usage

Place `"$safe-bash"` as an entry in `rules`. It mixes freely with regular rule objects and expands in place:

```jsonc
{
  "policies": {
    "readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }  // expands to ~90 rules
      ]
    }
  }
}
```

See [`examples/sample.jsonc`](examples/sample.jsonc) for a complete working example, and [`src/utils/safe-commands.ts`](src/utils/safe-commands.ts) for the full pattern list.

---

## Examples

### Protect production configs

Block all writes inside a sensitive config directory, but allow reads.

```json
{
  "policies": {
    "config-readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" },
        { "action": "deny",  "tool": "bash", "pattern": "* > *" },
        { "action": "deny",  "tool": "bash", "pattern": "* >> *" }
      ]
    }
  },
  "locations": {
    "/etc/myapp": "config-readonly"
  }
}
```

---

### Audit-only mode

Log every tool call in a directory without blocking anything. Useful when first introducing controls to an existing project.

```json
{
  "policies": {
    "audit": {
      "defaultAction": "log",
      "rules": []
    }
  },
  "locations": {
    "/home/user/work": "audit"
  }
}
```

Every tool call targeting `/home/user/work` will surface a notification in the pi UI and proceed. No rules needed — `defaultAction: "log"` handles everything.

---

### Interactive gate on destructive commands

Require confirmation before any `rm`, `chmod`, or `truncate` command, but let everything else through silently.

```json
{
  "policies": {
    "cautious": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" },
        { "action": "ask", "tool": "bash", "pattern": "rm -rf *" },
        { "action": "ask", "tool": "bash", "pattern": "chmod *" },
        { "action": "ask", "tool": "bash", "pattern": "truncate *" },
        { "action": "ask", "tool": "bash", "pattern": "dd *" }
      ]
    }
  },
  "locations": {
    "/home/user": "cautious"
  }
}
```

Note: `"rm -rf *"` (score 8) is more specific than `"rm *"` (score 3), so both rules can coexist and both produce `ask`. The tiebreaker doesn't matter here — they have the same action.

---

### Allow git, block everything else

A strict allowlist policy: only git commands and file reads are permitted. Everything else is denied.

```json
{
  "policies": {
    "git-only": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" },
        { "action": "allow", "tool": "bash", "pattern": "git status" },
        { "action": "allow", "tool": "bash", "pattern": "git log *" },
        { "action": "allow", "tool": "bash", "pattern": "git diff *" },
        { "action": "allow", "tool": "bash", "pattern": "git add *" },
        { "action": "allow", "tool": "bash", "pattern": "git commit *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "bash", "pattern": "git push --force *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "git-only"
  }
}
```

Force pushes are denied outright. Regular pushes require confirmation. All other git subcommands are allowed. Any non-git bash command is caught by `defaultAction: "deny"`.

---

### GitHub tool lockdown

Block all GitHub MCP tools to prevent the agent from opening PRs, creating issues, or merging branches without explicit approval.

```json
{
  "policies": {
    "no-github": {
      "defaultAction": "allow",
      "rules": [
        { "action": "deny", "tool": "github_*" }
      ]
    },
    "github-with-approval": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask",  "tool": "github_create_pull_request" },
        { "action": "ask",  "tool": "github_merge_pull_request" },
        { "action": "deny", "tool": "github_delete_*" },
        { "action": "log",  "tool": "github_*" }
      ]
    }
  },
  "locations": {
    "/home/user/experiments": "no-github",
    "/home/user/work":        "github-with-approval"
  }
}
```

In `experiments`, all `github_*` tools are denied (score 7 for `"github_*"`).

In `work`, the specific tools `github_create_pull_request` and `github_merge_pull_request` score 26 and 26 respectively, beating the catch-all `"github_*"` (score 7). Delete operations are denied. All other GitHub tools are logged and allowed.

---

### Per-project policy with global fallback

Set a permissive global fallback so unrecognized paths don't get blocked, while applying a strict policy to specific projects.

```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "edit" }
      ]
    },
    "open": {
      "defaultAction": "allow",
      "rules": []
    }
  },
  "locations": {
    "/home/user/work/critical-service": "strict"
  },
  "defaultPolicy": "open"
}
```

Any path inside `/home/user/work/critical-service` gets the `strict` policy. Everything else — `/tmp`, `/home/user/scratch`, etc. — falls through to `open` (fully permissive).

Without `defaultPolicy`, any path that doesn't match a location would be unrestricted anyway (fail-open). Setting `defaultPolicy: "open"` makes that intent explicit.

---

### Layered home and project policies

Apply a moderate policy to the whole home directory, and a stricter one to a specific project. The most specific location always wins.

```json
{
  "policies": {
    "moderate": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "rm *" },
        { "action": "ask", "tool": "bash", "pattern": "sudo *" },
        { "action": "log", "tool": "write" }
      ]
    },
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "deny",  "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/user":                 "moderate",
    "/home/user/work/production": "strict"
  }
}
```

| Path | Policy | `rm /tmp/foo` result |
|------|--------|----------------------|
| `/home/user/scratch/test.ts` | `moderate` | **ask** |
| `/home/user/work/production/src/main.ts` | `strict` | **deny** |
| `/var/log/app.log` | _(no match, no defaultPolicy)_ | **allow** (fail-open) |

---

### Redirect-aware bash policies

Policies apply not just to the command itself, but to any files it writes via redirects. This catches commands that would smuggle data out of a restricted location.

```json
{
  "policies": {
    "confidential": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "cat *" }
      ]
    },
    "open": {
      "defaultAction": "allow",
      "rules": []
    }
  },
  "locations": {
    "/home/user/secrets": "confidential",
    "/tmp":               "open"
  }
}
```

- `cat /home/user/secrets/key.pem` — source is in `confidential` → **allow** (matches `cat *`)
- `cat /home/user/secrets/key.pem > /tmp/key.pem` — redirect target `/tmp/key.pem` is in `open` (**allow**), but source is in `confidential` (**allow** via `cat *`). Most restrictive: **allow**. The cat is permitted.
- `cp /home/user/secrets/key.pem /tmp/key.pem` — `cp` doesn't match any rule in `confidential` → `defaultAction: deny` → **deny**.

> Note: pi-controls extracts redirect targets (`>`, `>>`, `<`, etc.) from the bash AST. It does not track the contents of files or data flowing through pipes — only where the command writes to explicitly.

---

### Mixed restrictiveness across pipeline stages

Each stage in a piped or `&&`-chained command is evaluated independently. The most restrictive result across all stages applies to the entire command.

```json
{
  "policies": {
    "safe": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "bash", "pattern": "grep *" },
        { "action": "allow", "tool": "bash", "pattern": "cat *" },
        { "action": "deny",  "tool": "bash", "pattern": "curl *" }
      ]
    }
  },
  "locations": {
    "/home/user/work": "safe"
  }
}
```

| Command | Stage results | Final |
|---------|---------------|-------|
| `cat file.txt \| grep foo` | allow, allow | **allow** |
| `curl https://example.com \| grep secret` | deny, allow | **deny** |
| `grep pattern file.txt && curl https://log-server.io` | allow, deny | **deny** |

The `curl` stage is denied, which locks the entire pipeline regardless of what the other stages do.

---

### Nudge toward better tools

Allow a tool call but inject a reminder into the result so the LLM is guided toward a preferred alternative — without blocking it outright. This is useful for steering agents toward domain-specific or more efficient tools without hard enforcement.

```json
{
  "policies": {
    "guided": {
      "defaultAction": "allow",
      "rules": [
        { "action": "nudge", "tool": "read",  "message": "Prefer pluck_read for repo files — it provides outline mode and semantic context." },
        { "action": "nudge", "tool": "grep",  "message": "Prefer pluck_grep for content search — it understands code structure." },
        { "action": "nudge", "tool": "bash",  "pattern": "grep *", "message": "Prefer rg (ripgrep) over grep — faster and .gitignore-aware." }
      ]
    }
  },
  "locations": {
    "$cwd": "guided"
  }
}
```

When the agent calls `read`, it still gets the file contents — but the tool result also contains:

```
[pi-controls nudge] Prefer pluck_read for repo files — it provides outline mode and semantic context.
```

A warning notification is also shown in the pi UI. The LLM can act on the hint immediately or on its next turn.

**Nudge vs. other actions:**
- Unlike `log`, nudge surfaces the message *inside the tool result* where the LLM sees it directly, not just in the UI.
- Unlike `deny`, nudge never blocks — the agent always gets its result.
- Unlike `ask`, nudge requires no human interaction.

**Restrictiveness:** nudge is treated as less restrictive than `log` when multiple location policies are combined. If one location says `nudge` and another says `deny` for the same tool call, `deny` wins.

---

### Nudge timeout — escalating ignored nudges

If an agent keeps using a discouraged tool despite repeated nudges, escalate automatically to a hard deny after a configurable threshold.

```json
{
  "policies": {
    "guided": {
      "defaultAction": "allow",
      "rules": [
        { "action": "nudge", "tool": "read",  "message": "Prefer pluck_read for repo files — outline mode + semantic context, far cheaper than a raw read." },
        { "action": "nudge", "tool": "grep",  "message": "Prefer pluck_grep for content search — ripgrep behavior, kept inside the index." },
        { "action": "nudge", "tool": "bash",  "pattern": "cat *",  "message": "Prefer pluck_read over cat for repo files (raw:true for exact bytes)." },
        { "action": "nudge", "tool": "bash",  "pattern": "grep *", "message": "Prefer pluck_grep over grep for repo text search." }
      ]
    }
  },
  "locations": {
    "$cwd": "guided"
  },
  "nudgeTimeout": {
    "maxNudges": 3,
    "windowSeconds": 60
  }
}
```

After 3 ignored nudges for the same rule within 60 seconds, the next call is hard-denied with a reason like:

```
[pi-controls] Access denied by policy: read — blocked path: "/home/user/project/src/main.ts".
The restriction is on the PATH "/home/user/project/src/main.ts" — not on the tool.
Do NOT retry with a different tool; all access to these paths is blocked.
You were repeatedly warned: "Prefer pluck_read for repo files — outline mode + semantic context,
far cheaper than a raw read." You MUST switch approach now.
```

Each nudge rule escalates independently. The `read` counter and the `bash:grep *` counter are separate — an agent that ignores `read` nudges does not burn up the `grep` counter, and vice versa.

After escalation the counter resets, so the agent gets another window of `maxNudges` chances rather than being permanently locked.

---

### Agent timeout as a safety net

Catch a rogue agent automatically: if it racks up three denied calls in a minute, escalate the next one to a manual confirmation instead of silently blocking it.

```json
{
  "policies": {
    "cautious": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git push *" }
      ]
    }
  },
  "locations": {
    "$cwd": "cautious"
  },
  "agentTimeout": {
    "maxDenies": 3,
    "windowSeconds": 60
  }
}
```

With this config, if the agent hits three denied calls within 60 seconds — for example, trying `rm`, `curl`, and `pip install` in quick succession — the fourth denied call becomes an `ask`. You see the confirmation dialog, can review what the agent is attempting, and either allow it or block it. The escalation continues on every subsequent deny until the deny rate drops below the threshold.

Pair this with a strict `defaultAction: "deny"` policy to maximize the benefit: the agent gets blocked early, and the circuit breaker kicks in before it burns too many turns.

---

## Config Reference

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `policies` | `Record<string, Policy>` | No | Named policies available for use in `locations`. |
| `locations` | `Record<string, string>` | No | Maps filesystem paths to policy names. |
| `approvalRules` | `Rule[]` | No | Allow rules saved by **Allow for Project** or **Allow Globally**. Global and project-local lists are combined. These rules override ordinary location-policy rules but never `pathProtection`. |
| `defaultPolicy` | `string \| null` | No | Policy to apply when no location matches. `null` or absent = fail-open. |
| `agentTimeout` | `AgentTimeout \| null` | No | Circuit breaker: escalate `deny` → `ask` when the deny rate exceeds the threshold. `null` or absent = disabled. |
| `nudgeTimeout` | `NudgeTimeout \| null` | No | Circuit breaker: escalate `nudge` → `deny` when the same nudge rule is ignored too many times. `null` or absent = disabled. |
| `interpreterAnalysis` | `InterpreterAnalysis \| null` | No | Conservative analysis of Python, Node, Bun, and nested shell source. Defaults to enabled; `null` disables it. |

### InterpreterAnalysis fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable interpreter source analysis. |
| `unknownAction` | `"ask" \| "deny"` | `"ask"` | Action when source, effects, or target paths cannot be fully analyzed. |
| `maxSourceBytes` | `number` | `262144` | Maximum embedded source size accepted for analysis. |
| `maxDepth` | `number` | `4` | Maximum recursive `bash -c`/`sh -c` wrapper depth. |
| `maxNodes` | `number` | `10000` | Maximum syntax-tree nodes visited per embedded source. |

### AgentTimeout fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxDenies` | `number` | Yes | Number of denied calls within `windowSeconds` that triggers escalation. |
| `windowSeconds` | `number` | Yes | Rolling window size in seconds. Events older than this are ignored. |

### NudgeTimeout fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxNudges` | `number` | Yes | Number of nudges for the same rule within `windowSeconds` before escalating to deny. |
| `windowSeconds` | `number` | Yes | Rolling window size in seconds. Events older than this are ignored. |

### Policy fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `defaultAction` | `"allow" \| "ask" \| "deny" \| "log"` | Yes | Action when no rule matches. |
| `rules` | `Rule[]` | Yes | Ordered list of rules (order does not affect matching — specificity does). |

### Rule fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"allow" \| "nudge" \| "ask" \| "deny" \| "log"` | Yes | What to do when this rule matches. |
| `tool` | `string` | Yes | Tool name or glob. Wildcards: `*` (any chars), `?` (one char). |
| `pattern` | `string` | bash only | Glob matched against the full command string. Only used when `tool` is `"bash"`. |
| `message` | `string` | nudge only | Reminder text prepended to the tool result (so the LLM sees it first) and shown in the pi UI. Required when `action` is `"nudge"`. |
| `allowUnanalyzed` | `boolean` | No | For an `allow` Bash rule, bypasses the interpreter-analysis fallback when its source cannot be analyzed. Use only for a narrowly trusted command pattern, such as `"bun run*"`. |
| `policy` | `string` | approval rules only | Limits an interactive approval to one named policy. Omit it only for a deliberately policy-agnostic manual approval. |

### Persisting an approval

An `ask` prompt can offer **Allow for Project** and **Allow Globally** in addition to the one-time and session choices. Both save a generated `allow` rule to `approvalRules`:

- **Allow for Project** writes `.pi/extensions/pi-controls.jsonc`, creating it under the current working directory when no project config exists.
- **Allow Globally** writes `<agentDir>/extensions/pi-controls.jsonc`.

A saved rule is immediately active for the current session and is loaded on later sessions. When a call resolves to more than one policy, choosing either persistent option opens a follow-up selector; choose the one policy that should receive the saved rule.

### Glob syntax

Both `tool` and `pattern` support `*` and `?` wildcards:

| Pattern | Matches |
|---------|---------|
| `"bash"` | exactly `bash` |
| `"github_*"` | `github_create_pr`, `github_list_issues`, … |
| `"git *"` | `git status`, `git commit -m "x"`, `git push origin main`, … |
| `"git commit *"` | `git commit -m "x"`, `git commit --amend`, … |
| `"rm *"` | `rm foo`, `rm -rf /tmp`, … |
| `"*"` | everything |

In `pattern`, `*` matches any character including spaces, slashes, and flags — it matches the entire remainder of the command string, not just a single word.

---

## Development

```sh
bun install       # install dependencies
bun test          # run all tests
bun run check     # lint with Biome
bun run format    # format with Biome
```

Tests live in `tests/` and use `bun:test`. Each utility module has its own test file.

```
src/
  index.ts          # Extension entry point; registers tool_call and tool_result handlers
  config.ts         # Config schema and ConfigLoader setup
  hooks/
    tool-call.ts    # tool_call handler; exports pendingNudges map for nudge injection
  utils/
    path.ts           # Path normalization and ~ expansion
    location.ts       # Path → policy resolution
    matching.ts       # Rule matching, specificity scoring, action resolution
    bash-ast.ts       # bash-parser wrapper with regex fallback
    deny-tracker.ts   # Sliding-window counter used by both agentTimeout and nudgeTimeout circuit breakers
tests/
  hooks/
    tool-call.test.ts
  utils/
    path.test.ts
    location.test.ts
    matching.test.ts
    bash-ast.test.ts
    deny-tracker.test.ts
```
