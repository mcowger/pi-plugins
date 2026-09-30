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
  - [Auto Fallthrough](#auto-fallthrough)
  - [Locations](#locations)
- [Subagent Ask Forwarding](#subagent-ask-forwarding)
- [Rule Matching and Specificity](#rule-matching-and-specificity)
- [Multi-Target Resolution](#multi-target-resolution)
- [Bash Command Parsing](#bash-command-parsing)
- [Safe Command Patterns](#safe-command-patterns)
- [Eval Classification](#eval-classification)
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

To test an unreleased version from the monorepo checkout, install the package directory:

```sh
pi install ./packages/pi-control
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
| `auto` | Defer to the Decisions API when this action wins: the model answers capability/blast-radius questions and deterministic rules map them to `allow` / `ask` / `deny`. See [Auto Fallthrough](#auto-fallthrough). |

`defaultAction` follows the same behaviors and is used when no rule in the policy matches the current tool call. `"nudge"` is not valid as a `defaultAction` — it requires a `message` field which only makes sense on explicit rules. `"auto"` is valid in both places.

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

### Auto Fallthrough

The `auto` action is a final fallthrough that reasons about a tool call instead of silently allowing it. When the winning action for a call is `auto`, pi-controls assembles the call's context and sends it to the Decisions API with a universal capability/blast-radius question set. Deterministic rules map the answers to a terminal `allow` / `ask` / `deny`. It is designed for permissive defaults (`"defaultAction": "auto"`) that should catch risky calls no pattern rule anticipated.

```jsonc
{
  "policies": {
    "cwd": {
      "defaultAction": "auto",   // explicit rules below still win
      "rules": [
        { "action": "ask", "tool": "bash", "pattern": "git push*" }
      ]
    }
  },
  "decisions": {
    "url": "https://openrouter.ai/api/alpha/decisions",
    "tokenEnv": "OPENROUTER_API_KEY",
    "auto": { "deny": true }
  }
}
```

**What is sent.** The tool name, a normalized form of the input (bash command; write size plus a head/tail preview; edit changed regions; grep/find/ls fields; custom-tool JSON), the working directory, resolved targets (each labelled `within`, `temporary`, `outside`, or `sensitive_system`), the tool description and schema from `pi.getAllTools()`, the current user prompt, and ~6 recent conversation turns (one-line summaries only). No matched policy or rules, and no redaction.

**Data egress.** All of the above leaves your machine and is sent to the configured `decisions.url` (OpenRouter by default). There is no redaction, so secrets in a prompt, command, or file content are transmitted and are also written unredacted to `pi-controls.log`. Point `url` at an endpoint you trust, or leave `auto` disabled for sensitive repositories.

**Questions.** Seven, answered in a single round trip: `action_class`, `scope`, and `data_sensitivity` (choice), plus `destructive`, `network`, `concealed`, and `inference_call` (boolean). The model is eyes; code decides.

**Scope is resolved locally when possible.** When every path a call can touch is known (a `path` input on built-in tools, or a bash command whose arguments and redirects contain no expansions), pi-controls classifies those paths itself and replaces the model's `scope` answer: `within` the cwd, `temporary` (`/tmp`, `/var/tmp`, `/dev/shm`), `outside`, or `sensitive_system` (OS directories, credential stores such as `~/.ssh` and `~/.aws`, `.env`, key files). The riskiest target wins, and `/dev/null`-style sinks are ignored. A fully static bash command that names no paths keeps the model's `remote`/`not_applicable` answer, with an `unknown` collapsed to `not_applicable`. Anything else (expansions, custom tools with no path field) uses the model's answer unchanged. The trace records which one applied as `scopeSource` (`deterministic`, `fallback`, or `model`).

**Verdicts.** A `deny` requires one of four curated shapes: `destructive + out-of-scope`, `destructive + concealed`, `sensitive-data + network + transmit` (a `remote_write`, or a `process_exec` that also touches a `sensitive_system` location), or `concealed + capability`. Everything else risky asks. A weighted-score backstop catches accumulated weak signals and can only ever ask, never deny. Set `"deny": false` to cap every auto verdict at `ask`.

**Explanations.** An `auto` ask prompt or deny reason says why, not just which rule fired: the rule, the classifier's probabilities for the signal that drove it, the signals it did *not* find, where `scope` came from, and the targets. For example:

```
auto: rule sensitive-read: data_sensitivity=sensitive (sensitive 0.70, ordinary 0.25); other signals: destructive=no, network=no, concealed=no; scope=outside (from paths); targets: /home/me/.pi/agent/extensions/pi-controls.log (outside)
```

`uncertain-critical` lists each undecided dimension with its probabilities, and a backstop ask shows the score and its top contributions. Cached verdicts keep their explanation, prefixed `auto (cached):`.

**Combination.** `auto` participates in the usual ranks: within a policy it loses same-specificity ties to explicit rules, and across targets it sits between `ask` and `log`. Explicit `deny`/`ask` rules therefore always win — `auto` is only ever the fallthrough.

**When auto does not call the API.** `ignore` mode, a session allowlist covering the call, a missing `decisions` block (falls back to `ask` with a one-time warning), or a command where every `auto`-producing stage was itself classified by [Eval Classification](#eval-classification) (the eval classifier is the specialist for those stages). A command that mixes an eval stage with a non-eval stage is still evaluated for the non-eval part. A saved approval rule needs no special case: it contributes an explicit `allow` for its target, so auto only runs when some target is still unapproved.

**Cost.** One request per unmatched call; repeat calls with the same tool/input/targets/cwd are served from a session cache, cleared on config reload. There is no per-session budget cap. Set a credit limit on the API key, as with eval classification.

**Logging.** Every evaluation appends an `auto` trace to `pi-controls.log`: the exact state and questions sent, raw answers plus token/cost usage, applied thresholds and weights, the rule or score breakdown, and the final verdict.

---

### Feedback Messages

When pi-controls acts on a tool call, it shows a notification in the pi UI and (for deny/ask) sends a reason message to the LLM.

**Nudge (single line, tool proceeds):**
```
pi-controls: nudge [policy] — You called the `read` tool. Prefer pluck_read for repo files — outline mode + semantic context.
```

For bash the caller context names the shell command and matched pattern, so the
model can tell the native tool apart from the shell invocation:
```
pi-controls: nudge [policy] — You ran bash `grep foo` (matched pattern `grep *`). Prefer the grep tool over the bash grep command.
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

**Deny (path restriction — every tool is blocked):**
```
pi-controls: deny [policy]: write — blocked path: "/etc/secrets"
```
LLM receives: `Access denied by policy: write — blocked path: "/etc/secrets". The restriction is on the PATH — not on the tool. Do NOT retry with a different tool.`

**Deny (tool restriction — only this tool is blocked):**
```
pi-controls: deny [policy]: write — path: "/tmp/out.txt"
```
LLM receives: `Access denied by policy: write — path: "/tmp/out.txt". The restriction is on the tool "write", not the path "/tmp/out.txt" — another tool can still reach it. Retry with a different tool instead.`

The sentence is chosen from the rule that decided the verdict. A `pattern` deny cites the
pattern and never claims a path is blocked (so it never names the cwd fallback), a
tool-specific rule says another tool can still reach the path, and a policy
`defaultAction: "deny"` keeps the path-restriction wording.

**Inform mode (would-block preview, nothing actually blocked):**
```
pi-controls: would-deny [policy]: git commit -m "..." — pattern: "git commit *"
```

Path labels in notifications:
- **`blocked path`** — on a `deny` from a path restriction (`defaultAction: "deny"`), where the path is unreachable by every tool
- **`path`** — on a `deny` from a tool-specific rule (another tool can still reach it), and on `log`/`ask`

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

Matching is symlink-aware: the target path and each configured location are resolved with `realpath` before comparison. A symlink inside a permitted directory that points into a protected one (for example `./ssh -> ~/.ssh`) resolves to the protected location, so it cannot be used to inherit the permitted directory's policy. Targets that do not exist yet — such as a file about to be written — resolve up to their longest existing parent.

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

## Subagent Ask Forwarding

When a subagent child session evaluates a tool call to `ask`, there is no UI in the child to answer it. pi-control forwards the prompt to the parent session instead: the child writes the ask into the parent's inbox, and the parent — the session with the terminal — shows the same Allow / Deny dialog, with the same choices the child would have offered. The chosen label travels back to the child, which applies it exactly as if the user had answered locally (including "Allow for session" and saved approval rules).

Forwarding is automatic. Nothing needs to be configured, and no other package needs to be installed:

- **In-process children** (e.g. `@gotgenes/pi-subagents`) are detected from the `subagents:child:session-created` / `subagents:child:disposed` lifecycle events the spawner publishes, and the parent is resolved from that registration.
- **Out-of-process children** are detected from `PI_SUBAGENT_PARENT_SESSION` (or a known third-party subagent marker), and the parent is resolved from that variable.

A child only waits while the parent is actually draining its inbox. If the parent has exited, stopped polling, or names a different session, the child gives up after a short grace window and the tool call is denied — never silently allowed. A child that has a UI of its own falls back to a local dialog when forwarding is unavailable.

Forwarded-ask state lives under `<agentDir>/extensions/pi-controls-forwarding/`. It is drained and cleaned up per session; only request/response records for in-flight asks are ever present.

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

**Tiebreaker:** when two rules have the same specificity score, the least-disruptive action wins: `allow > nudge > ask > deny > log > auto`. You never accidentally block something more than the rules intend. `auto` sorts last here on purpose: an explicit rule always wins a same-specificity tie, and `auto` only takes effect when nothing more specific (or equally specific) matched.

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

Restrictiveness order: `deny > ask > auto > log > nudge > allow`

`auto` sits between `ask` and `log`, so an explicit `deny` or `ask` from any target beats a model verdict, while `auto` beats a bare `allow`/`log`/`nudge`. A call whose combined action is `auto` is evaluated **once**, against every target at once.

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

Bash commands are parsed with the prebuilt Tree-sitter Bash grammar distributed by [`@vscode/tree-sitter-wasm`](https://www.npmjs.com/package/@vscode/tree-sitter-wasm).

From each shell stage, pi-controls extracts:

- **Command name + arguments** — used for pattern matching against bash rules
- **File redirect targets** — paths like `> /tmp/out.txt` or `>> log.txt` checked against location policies
- **fd-to-fd redirects** like `2>&1` — recognized and skipped because they do not target files
- **Path-like arguments** — tokens like `~`, `/tmp/foo`, or `./bar` checked against location policies

Each pipeline or logical stage (`|`, `&&`, `;`) is evaluated independently. The most restrictive action across all stages and discovered targets wins.

**If Tree-sitter fails to load**, pi-controls falls back to a simple tokenizer and ordinary CWD policy evaluation still applies.

---

## Safe Command Patterns

pi-controls ships a built-in preset, `"$safe-bash"`, that expands to ~140 allow rules for non-mutating bash commands. Use it anywhere in a `rules` array instead of listing the patterns by hand.

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
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }  // expands to ~140 rules
      ]
    }
  }
}
```

See [`examples/sample.jsonc`](examples/sample.jsonc) for a complete working example, and [`src/utils/safe-commands.ts`](src/utils/safe-commands.ts) for the full pattern list.

---

## Eval Classification

Inline code evals — `python -c`, `node -e`, `bun -e`, `deno eval`, `tsx -e`, `bash -c`, and heredoc-fed interpreters — are invisible to path- and pattern-based policy. When the optional top-level `decisions` block is configured, each eval's source is sent to the configured Decisions endpoint (`POST {url}` via the official `@typesafe-ai/sdk` client), which answers capability/scope questions about the code. Absent the block, the feature is fully off: bash enforcement is location policy only, with zero network calls.

**Scope.** Only bash stages that execute inline code through a covered interpreter are classified. Ordinary shell commands, script-file and module runs (`python script.py`, `python -m pytest`), non-bash tools, and commands with an explicit session or saved approval never touch the API. Eval-shaped invocations with no recoverable source (`python -c "$CODE"`, `curl … | python3`) make no API call and fall back to `unavailableAction`.

**Verdict engine.** The model answers seven questions — `destructive`, `network`, `exec`, `obfuscated`, and pipeline-wide `inference_call` (boolean), plus `write_scope` and `read_scope` (choice questions scoped against the cwd, e.g. a write inside the project vs. one to `/etc`). A deterministic rule table maps the answers to `allow` / `ask` / `deny`: destructive, exfil-shaped (`sensitive` read + network), and concealed-capability (obfuscated + network/exec) combinations deny; out-of-scope writes, sensitive reads, and uncertainty ask; routine in-scope capabilities (including network- or subprocess-use alone) allow. A weighted-score backstop catches accumulated weak signals when no rule fires — it can only ever ask, never deny. Full question text, rule IDs, and weights live in [`docs/plans/2026-09-22-decisions-eval-classification.md`](docs/plans/2026-09-22-decisions-eval-classification.md).

**Combination.** The eval verdict combines upgrade-only with the location verdict via the usual most-restrictive rule: the model can escalate an `allow` to `ask`/`deny`, but can never downgrade a location `ask`/`deny`.

**Interaction with `auto`.** When an inline eval source is classified, the [`auto`](#auto-fallthrough) fallthrough is skipped for that call — the eval classifier is the specialist for inline code, which also avoids a second billed request.

**Auth.** The bearer token is read from the env var named by `tokenEnv` (default `OPENROUTER_API_KEY`); the token itself never appears in config. Set a credit limit on the key — a runaway agent with an unlimited key can spend the whole balance.

**Cost and latency.** Roughly one sub-second request per eval source (~$0.00002 in testing). Repeat evals are served from a session cache, and approved commands skip the API entirely.

**Tuning and logging.** Thresholds, buckets, and all backstop weights are config knobs (single weights can be overridden per project). Every classification appends a full trace to `pi-controls.log`: the exact state/questions sent, raw answers plus token/cost usage, applied weights and thresholds, the rule fired or score breakdown, and the final verdict — the dataset for future tuning.

### Calibration methodology

The questions, criteria, and rules above were not written from best guesses. They were tuned over seven rounds against **260 human verdicts on real inline evals** mined from 10 days of actual pi sessions (18,894 bash calls → 1,417 unique evals), split into train and holdback sets:

- Each round classified the labeled train set via the live API, diffed verdicts against human labels, and adjusted **questions and criteria first** — weights and thresholds were never touched (benign scores sit 4–28 against the 40 line).
- Label evidence overturned design twice: two proposed questions (external, then credentialed, egress) were added and later **removed** when labels showed routine admin checks allow — including a same-day revert of an overreaching filename rule.
- Tuning stopped at **~97% agreement** against a measured **~3% human label-error rate** (8 flipped labels of 260, plus 2 quarantined for redaction skew) and ±2 run-to-run model variance — the noise ceiling, where further tuning would fit noise. Residuals are documented, not tuned around.
- Holdback scored 48/50 on first measurement, matching train with no generalization gap.

The full round-by-round history, residual log, and stopping rule live in the design doc appendix.

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
[pi-controls nudge] You called the `read` tool. Prefer pluck_read for repo files — it provides outline mode and semantic context.
```

Bash nudges name the shell command and matched pattern instead, so the model
can tell the native tool apart from the shell invocation:

```
[pi-controls nudge] You ran bash `grep foo` (matched pattern `grep *`). Prefer the grep tool over the bash grep command.
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
[pi-controls] Access denied by policy: read — path: "/home/user/project/src/main.ts".
The restriction is on the tool "read", not the path "/home/user/project/src/main.ts" — another tool can still reach it.
Retry with a different tool instead.
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
| `decisions` | `DecisionsConfig \| null` | No | Decisions API configuration for [Eval Classification](#eval-classification) and the [Auto Fallthrough](#auto-fallthrough) action. `null` or absent = both disabled. |

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

### Decisions fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | No | Full endpoint URL. Defaults to `https://openrouter.ai/api/alpha/decisions`. |
| `tokenEnv` | `string` | No | Env var **name** holding the bearer token. Defaults to `OPENROUTER_API_KEY`. |
| `model` | `string` | No | Model requested from the Decisions router. Defaults to `typesafe/jev-1.13`. |
| `timeoutMs` | `number` | No | Per-request timeout in ms. Defaults to `15000`. |
| `maxSourceBytes` | `number` | No | Sources beyond this are truncated (flagged `truncated:true`). Defaults to `32768`. |
| `unavailableAction` | `"allow" \| "ask" \| "deny"` | No | Eval shape detected but source not recoverable. Defaults to `"ask"`. |
| `errorAction` | `"allow" \| "ask" \| "deny"` | No | API/network/auth/timeout/malformed failure. Defaults to `"ask"`. |
| `yesThreshold` | `number` | No | Boolean probability at/above this → yes. Defaults to `0.7`. |
| `noThreshold` | `number` | No | Boolean probability at/below this → no (between → uncertain). Defaults to `0.3`. |
| `choiceConfidence` | `number` | No | Choice top-label probability needed for a confident label. Defaults to `0.6`. |
| `riskyMassThreshold` | `number` | No | Below confidence, risky-label mass at/above this → uncertain (ask). Defaults to `0.35`. |
| `backstopThreshold` | `number` | No | Weighted score at/above this → ask. Defaults to `40`. |
| `weights` | `Record<string, number>` | No | Per-signal weights (`destructive`, `obfuscated`, `network`, `exec`, `writeSensitive`, `writeOutside`, `writeUnknown`, `readSensitive`, `readUnknown`). Deep-merged, so single weights can be overridden. |
| `auto` | `AutoConfig` | No | Tuning for the [Auto Fallthrough](#auto-fallthrough) action. Deep-merged over code defaults, so a project can override a single field or weight. |

### Auto fields

All fields are optional and live under `decisions.auto`.

| Field | Type | Description |
|-------|------|-------------|
| `deny` | `boolean` | When `false`, the engine can never deny — verdicts cap at `ask`. Defaults to `true`. |
| `yesThreshold` | `number` | Boolean probability at/above this → yes. Defaults to `0.7`. |
| `noThreshold` | `number` | Boolean probability at/below this → no (between → uncertain). Defaults to `0.3`. |
| `choiceConfidence` | `number` | Choice top-label probability needed for a confident label. Defaults to `0.6`. |
| `riskyMassThreshold` | `number` | Below confidence, risky-label mass at/above this → uncertain. Defaults to `0.35`. |
| `backstopThreshold` | `number` | Weighted score at/above this → ask. Defaults to `40`. |
| `thresholds` | `Record<string, { yes?, no? } \| { confidence?, riskyMass? }>` | Per-question bucket thresholds. Boolean questions (`destructive`, `network`, `concealed`, `inference_call`) take `yes`/`no`; choice questions (`action_class`, `scope`, `data_sensitivity`) take `confidence`/`riskyMass`. Unset entries use the globals above. Out-of-range values, and a `yes` not above `no`, fall back. |
| `maxInputBytes` | `number` | Per normalized input field byte cap. Defaults to `16384`. |
| `maxConversationTurns` | `number` | How many trailing conversation entries to send as grounding. Defaults to `6`. |
| `maxConversationBytes` | `number` | Total byte cap over the conversation slice and the user prompt. Defaults to `8192`. |
| `weights` | `Record<string, number>` | Backstop weights (`destructive`, `concealed`, `network`, `inferenceCall`, `scopeRisky`, `sensitiveData`). Deep-merged. |
| `questions` | `Record<string, { instructions?, criteria? }>` | Per-question overrides merged over the built-in question set. |

### Policy fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `defaultAction` | `"allow" \| "ask" \| "deny" \| "log" \| "auto"` | Yes | Action when no rule matches. |
| `rules` | `Rule[]` | Yes | Ordered list of rules (order does not affect matching — specificity does). |

### Rule fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `"allow" \| "nudge" \| "ask" \| "deny" \| "log" \| "auto"` | Yes | What to do when this rule matches. |
| `tool` | `string` | Yes | Tool name or glob. Wildcards: `*` (any chars), `?` (one char). |
| `pattern` | `string` | bash only | Glob matched against the full command string. Only used when `tool` is `"bash"`. |
| `message` | `string` | nudge only | Reminder text prepended to the tool result (so the LLM sees it first) and shown in the pi UI. Required when `action` is `"nudge"`. |
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
    bash-ast.ts       # Tree-sitter Bash parsing with tokenizer fallback
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
