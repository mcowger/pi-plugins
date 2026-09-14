# pi-controls Design

**Date:** 2026-05-04
**Status:** Approved

## Overview

`pi-controls` is a pi extension that enforces action-based policies on tool calls, scoped by filesystem location. It is distinct from pi-guardrails (which was reviewed as a reference implementation only). There is no migration path between the two.

---

## Core Concepts

### Policies

A **policy** is a named set of rules plus a default action. It answers the question: "given that I'm operating in a location governed by this policy, what am I allowed to do?"

Each policy has:
- A unique name (e.g. `"strict"`, `"relaxed"`)
- A `defaultAction` — what happens when no rule matches
- An ordered set of rules

### Rules

A rule has three fields:

| Field | Required | Description |
|-------|----------|-------------|
| `action` | always | `"allow"`, `"ask"`, `"deny"`, or `"log"` |
| `tool` | always | Tool name, supports globs (e.g. `"github_*"`) |
| `pattern` | bash only | Glob pattern matched against the command string |

`pattern` is only meaningful for `tool: "bash"`. For all other tools, the location boundary is the scope — no pattern is needed.

### Locations

A **location** is a filesystem path (directory or file) mapped to a policy name. The most specific matching location wins.

```
/home/mcowger/project  →  strict
/home/mcowger           →  relaxed
/tmp                    →  relaxed
```

If no location matches, no policy applies and all tool calls proceed (fail-open).

---

## Config Shape

Config file name: `pi-controls.json`

Global path: `getAgentDir()/extensions/pi-controls.json`
Project-local path: `.pi/extensions/pi-controls.json` (relative to CWD)

Project-local definitions win on conflict. Both levels are merged at startup using the same `ConfigLoader` pattern as pi-guardrails (from `@aliou/pi-utils-settings`).

```json
{
  "policies": {
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "bash", "pattern": "git *" },
        { "action": "ask",   "tool": "bash", "pattern": "git commit *" },
        { "action": "deny",  "tool": "bash", "pattern": "rm *" },
        { "action": "log",   "tool": "read" },
        { "action": "deny",  "tool": "write" },
        { "action": "deny",  "tool": "github_*" }
      ]
    },
    "relaxed": {
      "defaultAction": "allow",
      "rules": [
        { "action": "log", "tool": "bash", "pattern": "rm *" }
      ]
    }
  },
  "locations": {
    "/home/mcowger/project": "strict",
    "/home/mcowger": "relaxed",
    "/tmp": "relaxed"
  }
}
```

---

## Resolution Pipeline

### Step 1: Determine tool type

When a `tool_call` event fires:

- **bash** → use bash AST resolution (see below)
- **has `path` or `file_path` in input** → treat as a file tool, use the field value as the single target
- **anything else** → fall back to CWD as the target location

### Step 2: Resolve targets to locations

For each target path:
1. Normalize to absolute path (expand `~`, resolve relative to CWD)
2. Walk the `locations` map, find all entries where the target path starts with the location path
3. Pick the most specific match (longest location path wins)
4. Return the policy assigned to that location

If no location matches a target, that target contributes no policy (no constraint).

### Step 3: Find the matching rule

Within each applicable policy:
1. Filter rules where `tool` matches the tool name (glob match allowed)
2. For bash: further filter where `pattern` matches the command string (glob match)
3. Score each matching rule by **specificity**:
   - Count literal characters before the first wildcard in `pattern` (bash) or `tool` (non-bash)
   - Higher score = more specific = wins
   - Tiebreaker: `allow > ask > deny > log`
4. If no rule matches → use `defaultAction` (treated as specificity 0)

### Step 4: Resolve across multiple targets

When a bash command touches files in multiple locations (each potentially governed by a different policy), collect the winning action from each applicable policy and apply the most restrictive:

```
deny > ask > log > allow
```

---

## Bash AST Parsing

Shell commands are parsed using **`bash-parser`** — a standard-compliant bash parser that produces a full AST with command names, arguments, and redirect targets.

> **Note:** `sh-syntax` (mvdan/sh WASM) was evaluated but rejected: its JSON serialization strips all content from `Cmd` nodes, leaving only `Pos`/`End` position data. `bash-parser` was chosen as the replacement.

From the parsed AST, the following are extracted per pipeline stage:

- **Command name + arguments** — matched against bash rules
- **Redirect targets** — checked against location policies (e.g. `> /tmp/out.txt`)
- **`2>&1` and similar fd redirects** — recognized as non-file redirects and skipped

Each pipeline stage is evaluated independently. The most restrictive action across all stages and all file targets wins.

If AST parsing fails (malformed input), fall back to a regex tokenizer that extracts quoted and unquoted tokens, skipping anything that looks like a flag (`-`-prefixed).

---

## Action Handling

| Action | Behavior |
|--------|----------|
| `allow` | No-op. Tool call proceeds silently. |
| `log` | `ctx.ui.notify()` surfaces a message. Tool call proceeds. |
| `ask` | `ctx.ui.confirm()` pauses execution. If approved → proceeds. If denied → blocked, LLM receives reason. |
| `deny` | Tool call blocked immediately. LLM receives a reason message naming the rule that triggered. |

`defaultAction` follows the same four behaviors — it is treated as a rule with specificity 0 that matches everything.

---

## Specificity Scoring

For bash `pattern` fields:
- Score = number of literal characters before the first `*` or `?`
- `"git commit *"` → score 11
- `"git *"` → score 4
- `"*"` → score 0

For `tool` glob fields (non-bash):
- Same scoring applied to the tool name pattern
- `"github_create_pull_request"` → score 26 (no wildcard, full literal)
- `"github_*"` → score 7
- `"*"` → score 0

Tiebreaker when scores are equal: `allow > ask > deny > log`

---

## Module Structure

```
src/
  index.ts              # Extension entry — loads config, registers tool_call hook
  config.ts             # Schema (GuardrailsConfig / ResolvedConfig pattern),
                        # ConfigLoader setup using getAgentDir()
  hooks/
    tool-call.ts        # Main tool_call event handler — orchestrates resolution pipeline
  utils/
    location.ts         # Path → policy resolution (most specific location wins)
    matching.ts         # Rule matching and specificity scoring
    bash-ast.ts         # sh-syntax wrapper: parse pipeline, extract file targets + redirects
    path.ts             # Path normalization, home expansion, absolute resolution
tests/
  utils/                # Bun-compatible test harness (adapted from pi-guardrails pattern,
                        #   mock.fn() from bun:test instead of vi.fn())
  hooks/
    tool-call.test.ts
  utils/
    location.test.ts
    matching.test.ts
    bash-ast.test.ts
```

---

## Stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript (strict mode) |
| Runtime | Bun |
| Package manager | Bun (`bun install`, `bun.lockb`) |
| Test runner | `bun test` |
| Linter / formatter | Biome |
| Shell parser | `bash-parser` |
| Config loader | `@aliou/pi-utils-settings` (`ConfigLoader`) |

---

## Key Design Decisions (Summary)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default action | Per-policy (`defaultAction`) | Flexible; policies can be allowlists or blocklists |
| Rule actions | `allow`, `ask`, `deny`, `log` | Covers silent permit, interactive gate, hard block, audit |
| Specificity | Literal chars before first wildcard | Predictable, no rule ordering required |
| Tiebreaker | `allow > ask > deny > log` | Least surprising when two rules are equally specific |
| Multi-target resolution | Most restrictive wins | Conservative; a single constrained target locks the whole command |
| Location matching | Most specific path wins | Consistent with how developers reason about project boundaries |
| Bash no-file fallback | CWD policy | Commands without file args are still "happening in" a location |
| Non-bash path detection | Convention-based (`path` / `file_path` fields) | Future-proof, no hardcoded tool list to maintain |
| Config levels | Global (`getAgentDir()`) + project-local (`.pi/`) | Consistent with pi extension conventions |
| Relationship to pi-guardrails | Independent — reference only | No migration path; clean design unconstrained by legacy shape |
