---
name: pi-controls
description: Configure pi-controls policies and locations. Use when the user wants to set up, modify, or troubleshoot access control rules for the pi-controls extension.
---

# pi-controls Configuration

You are helping the user configure `pi-controls`, a pi extension that enforces action-based policies on tool calls scoped by filesystem location.

## Config files

There are two config file locations. Always ask the user which scope they want before writing:

| Scope | Path | When to use |
|-------|------|-------------|
| Global | `~/.pi/agent/extensions/pi-controls.json` | Rules that apply across all projects |
| Project-local | `.pi/extensions/pi-controls.json` (relative to CWD) | Rules for this project only |

Project-local wins on conflict. Both are merged at startup.

## Config structure

```json
{
  "policies": {
    "<policy-name>": {
      "defaultAction": "allow" | "ask" | "deny" | "log",
      "rules": [
        { "action": "allow" | "ask" | "deny" | "log", "tool": "<tool-or-glob>" },
        { "action": "allow" | "ask" | "deny" | "log", "tool": "bash", "pattern": "<command-glob>" }
      ]
    }
  },
  "locations": {
    "<absolute-path>": "<policy-name>"
  },
  "defaultPolicy": "<policy-name>" | null
}
```

## Actions

- `allow` — silent permit
- `log` — permit and notify the user in the pi UI
- `ask` — pause and ask the user for confirmation; denied → LLM receives a reason
- `deny` — block immediately; LLM receives a reason

## Rules and specificity

Rules are not ordered. The most specific matching rule wins:

- **Specificity** = number of literal characters before the first `*` or `?`
- `"git commit *"` → 11, `"git *"` → 4, `"*"` → 0
- **Tiebreaker** when scores are equal: `allow > ask > deny > log`

The `pattern` field only applies when `tool` is `"bash"`. For all other tools, omit it.

Tool globs use `*` (any chars) and `?` (one char): `"github_*"`, `"*"`, `"write"`.
Command patterns treat `*` as matching anything including spaces and slashes: `"git commit *"`, `"rm *"`.

## Location matching

- The most specific (longest) path wins when multiple locations match a target.
- `defaultPolicy` applies when no location matches. If absent or `null`, unmatched paths are unrestricted (fail-open).
- Paths are normalized: `~` is expanded, relative paths are resolved against CWD.

## Bash command evaluation

- Each pipeline stage (`|`, `&&`, `||`, `;`) is evaluated independently.
- File redirect targets (`> file`, `>> file`) are checked against location policies separately from the command itself.
- `2>&1` and similar fd redirects are ignored.
- The most restrictive result across all stages and all targets wins: `deny > ask > log > allow`.

## How to help the user

### 1. Understand their goal first

Ask what they are trying to protect or control. Common goals:

- Prevent accidental writes to sensitive directories
- Require confirmation before destructive bash commands (`rm`, `dd`, `truncate`)
- Block or gate GitHub tool calls (PRs, merges)
- Audit what the agent does in a directory without blocking it
- Apply different rules to different projects

### 2. Identify the right policy type

| Goal | Recommended shape |
|------|-------------------|
| Allowlist (only specific things permitted) | `defaultAction: "deny"` + explicit `allow` rules |
| Blocklist (everything allowed except some things) | `defaultAction: "allow"` + explicit `deny`/`ask` rules |
| Audit only | `defaultAction: "log"`, no rules needed |
| Interactive gate on specific commands | `defaultAction: "allow"` + `ask` rules for dangerous patterns |

### 3. Determine scope and locations

- Ask which directories should be covered.
- Ask whether rules should be global or project-local.
- If the user has nested directories with different risk levels (e.g. `~/work` vs `~/work/production`), set up separate policies for each and rely on most-specific-wins.

### 4. Build the config incrementally

Start minimal — a single policy with a `defaultAction` and the most important rules. Let the user confirm before adding complexity.

### 5. Validate before writing

Before writing the config file:
- Confirm every `locations` entry references a policy name that exists in `policies`.
- Confirm every `defaultPolicy` value (if set) references a policy name that exists.
- Confirm bash rules have a `pattern` field; non-bash rules do not.
- Confirm all paths in `locations` are absolute (not relative, not `~`-unexpanded — pi-controls expands `~` at runtime, but absolute paths are clearest for the user).

### 6. After writing

Tell the user that pi-controls reloads config on `session_start`. They need to restart pi or run `/reload` for changes to take effect.

## Example policies

### Read-only directory

```json
{
  "policies": {
    "readonly": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
        { "action": "allow", "tool": "find" },
        { "action": "allow", "tool": "ls" }
      ]
    }
  },
  "locations": {
    "/etc/myapp": "readonly"
  }
}
```

### Confirm destructive bash commands

```json
{
  "policies": {
    "cautious": {
      "defaultAction": "allow",
      "rules": [
        { "action": "ask",  "tool": "bash", "pattern": "rm *" },
        { "action": "ask",  "tool": "bash", "pattern": "dd *" },
        { "action": "ask",  "tool": "bash", "pattern": "truncate *" },
        { "action": "deny", "tool": "bash", "pattern": "rm -rf /*" }
      ]
    }
  },
  "locations": {
    "/home/user": "cautious"
  }
}
```

### Git-only with push confirmation

```json
{
  "policies": {
    "git-only": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "grep" },
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

### GitHub tool gate

```json
{
  "policies": {
    "github-gated": {
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
    "/home/user/work": "github-gated"
  }
}
```

### Layered policies with global fallback

```json
{
  "policies": {
    "open":   { "defaultAction": "allow", "rules": [] },
    "strict": {
      "defaultAction": "deny",
      "rules": [
        { "action": "allow", "tool": "read" },
        { "action": "allow", "tool": "bash", "pattern": "git *" }
      ]
    }
  },
  "locations": {
    "/home/user/work/production": "strict",
    "/home/user/work":            "open"
  },
  "defaultPolicy": "open"
}
```
