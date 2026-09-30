---
name: pi-controls
description: Configure the pi-controls extension (@mcowger/pi-control) for Pi — policies, locations, rules, bash patterns, nudges, path protection, approvals, circuit breakers, and the `auto` / Decisions API fallthrough. Explains exactly which rule wins and why. TRIGGERS - pi-controls, pi-control, pi-controls.jsonc, tool call policy, block a command in pi, allow bash command, ask before running, nudge rule, $safe-bash, pathProtection, approvalRules, defaultPolicy, agentTimeout, nudgeTimeout, auto action, decisions block, jev, why was this blocked, why did pi ask.
---

# pi-controls configuration

pi-controls checks every Pi tool call (bash, read, write, edit, MCP tools, …) against policies scoped by filesystem location, then allows, nudges, logs, asks, denies, or defers to a model (`auto`).

Your job with this skill: turn what the user wants in plain words ("ask before any git push", "never touch ~/.ssh", "read-only outside this repo") into a correct config, and explain surprising verdicts. Users should not need to learn the syntax.

## Workflow

1. **Ask what they want to protect or allow, and where.** Get concrete commands, tools, and directories. Don't ask about syntax.
2. **Read the existing config first** (both files below). Never overwrite; merge into what's there.
3. **Pick the scope** — global or project. Default to global for personal safety rules and project for repo-specific ones. Ask if unclear.
4. **Draft the smallest config that does it.** Walk through the precedence rules below for 2–3 of the user's real commands and show the verdict each gets.
5. **Validate** with the checklist at the end, then write the file.
6. **Tell them to `/reload`** (or restart Pi) and how to check it took effect.

## Files

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/extensions/pi-controls.jsonc` (or `.json`) |
| Project | `.pi/extensions/pi-controls.jsonc` — found by walking up from the cwd, stopping at `$HOME` |
| Log | `~/.pi/agent/extensions/pi-controls.log` |

JSONC, so `//` comments are fine.

**How the two files combine** — a key-by-key deep merge, project over global:

- Objects merge key by key. A project can override one policy, one location, or one `decisions.auto` weight without restating the rest.
- **Arrays replace, they don't append.** If both files define policy `"dev"`, the project's `rules` array replaces the global one entirely (though a `defaultAction` set only globally survives). To add rules, give the project policy a new name, or copy the global rules into it.
- `approvalRules` is the one exception: global and project lists are concatenated.

**Project discovery gotcha:** the loader stops at the *first* `.pi/` directory it finds walking up. If `repo/sub/.pi/` exists without a pi-controls file, `repo/.pi/extensions/pi-controls.jsonc` is **not** loaded.

**Silent failure gotcha:** a file with a JSON syntax error is ignored with no error. After editing, check the log's startup line: `loaded: N policies, M locations, defaultPolicy=…`.

## The config shape

```jsonc
{
  "policies": {
    "<name>": {
      "defaultAction": "allow" | "ask" | "deny" | "log" | "auto",   // not "nudge"
      "rules": [
        { "action": "…", "tool": "<tool or glob>" },
        { "action": "…", "tool": "bash", "pattern": "<command glob>" },
        { "action": "nudge", "tool": "…", "message": "<hint for the agent>" },
        { "action": "allow", "tool": "bash", "pattern": "$safe-bash" }  // expands to ~140 read-only commands
      ]
    }
  },
  "locations": { "<absolute path or $cwd>": "<policy name>" },
  "defaultPolicy": "<policy name>" | null,
  "pathProtection": { "<glob>": "deny" },
  "agentTimeout": { "maxDenies": 3, "windowSeconds": 60 },
  "nudgeTimeout": { "maxNudges": 3, "windowSeconds": 60 },
  "approvalRules": [ /* written by the Allow for Project / Allow Globally buttons */ ],
  "cycleKey": "ctrl+shift+m",
  "decisions": { /* optional; enables auto + eval classification — see references/decisions-auto.md */ }
}
```

### Actions

| Action | Effect |
|---|---|
| `allow` | Runs silently. |
| `nudge` | Runs, but `message` is prepended to the tool result so the agent sees it. Needs `message`. Rules only. |
| `log` | Runs; shows a UI notification. For auditing. |
| `ask` | Pauses for the user: Allow / Allow for session / Allow for Project / Allow Globally / Deny. |
| `deny` | Blocked; the agent gets a reason. |
| `auto` | Sends the call to the Decisions API, which returns allow/ask/deny. Without a `decisions` block it becomes `ask` (with a one-time warning). |

## Precedence: how a verdict is decided

Walk these steps in order. This is where almost all confusion comes from, so use it when explaining a verdict.

**0. Mode.** `/controls enforce|inform|ignore` (or the `cycleKey` shortcut). `ignore` skips everything. `inform` evaluates and shows `would-deny` etc. but never blocks. `enforce` is the default.

**1. `pathProtection` runs first and can't be overridden** — it blocks even in `inform` mode. Globs are matched against each target's basename *and* full canonical path (minimatch, dotfiles included). Only `"deny"` has any effect. Session allows and saved approvals don't bypass it. `~` is **not** expanded in these globs, so use basename globs (`"*.env"`, `"id_rsa*"`), `**/` globs (`"**/.ssh/**"`), or absolute paths.

**2. Find the targets.**
- `read`/`write`/`edit`/`grep`/`find`/`ls`: the `path`/`file_path` input. With no path input (most MCP tools), the target is the cwd.
- `bash`: parsed with tree-sitter into stages split on `|`, `&&`, `||`, `;`. Each stage's targets are its path-like arguments (`/x`, `~/x`, `./x`, `../x`) and file redirects (`> out.txt`). A stage with none targets the cwd. **A bare filename like `foo.txt` is not path-like**, so it isn't a target. fd redirects (`2>&1`, `2>/dev/null`) are ignored.

**3. Pick a policy per target** — the longest matching `locations` entry wins. Paths are symlink-resolved on both sides, `~` is expanded, and `"$cwd"` means the directory Pi runs in. With no match, `defaultPolicy` applies. With no `defaultPolicy` either, **that target is unrestricted** (fail-open).
- **Typo trap:** a location that points at a policy name that doesn't exist is also unrestricted. It does *not* fall back to `defaultPolicy`.
- **Scope trap:** with only `"$cwd": "strict"` and no `defaultPolicy`, `cat /etc/shadow` is evaluated against `/etc` → no policy → allowed. Set `defaultPolicy` if the rules should apply everywhere.

**4. Inside the policy, pick one rule.**
- First, saved `approvalRules` (allow-only, limited to that policy when they carry `"policy"`) win over the policy's own rules for that target.
- Otherwise, every rule whose `tool` glob matches (and, for bash, whose `pattern` matches the stage) is a candidate. **The most specific wins**: specificity = the number of literal characters before the first `*` or `?` in the `pattern` (bash) or in the `tool` glob (a rule with no pattern). A string with no wildcard scores its full length.
- Ties go to the least disruptive action: `allow > nudge > ask > deny > log > auto`. So an explicit rule always beats an `auto` rule of equal specificity.
- No candidates → the policy's `defaultAction`.

**5. Combine targets and stages — the most restrictive wins:** `deny > ask > auto > log > nudge > allow`. For example, `cat src/x > /etc/y` takes the stricter of the two locations' verdicts, and `ls && rm -rf build` takes the stricter of the two stages.

**6. Eval classification** (only with `decisions` configured): inline code (`python -c`, `node -e`, heredoc to an interpreter, `bash -c`) is classified by the model. It can only raise the verdict, never lower it.

**7. `auto` resolves** to allow/ask/deny (see references). It's skipped when a session allow covers the call.

**8. Circuit breakers** apply to the final action: `nudgeTimeout` turns a repeatedly ignored nudge (per rule) into `deny`; `agentTimeout` turns a deny into `ask` once too many denies land in the window.

**9. `ask` prompts** are skipped if the user already chose "Allow for session" for a matching call. Session allows never bypass `deny`.

### Pattern matching rules (bash)

- `pattern` is matched against **each stage** separately, anchored at both ends. `*` matches anything, including spaces and `/`; `?` matches one character.
- `"git *"` matches `git status` but **not bare `git`**. `"git status"` matches only exactly `git status`, not `git status -s`. Use `"git status*"` to cover both.
- Stage text has shell quotes decoded: `git commit -m "fix bug"` is matched as `git commit -m fix bug`.
- It's prefix-anchored: `"rm *"` does **not** match `sudo rm -rf x`. Add `"sudo *"` rules if that matters.
- `cd dir && make` has two stages, and `cd dir` needs its own allow (or a permissive default) under an allowlist policy. `$safe-bash` covers `pwd`, `ls`, `cat`, `git status`, etc. but **not `cd`**, so add `{ "action": "allow", "tool": "bash", "pattern": "cd *" }`.

### Tool hiding (happens before any call)

At the start of each agent turn, pi-controls removes from the agent's toolset any tool that **every active policy** denies. Active policies are all those referenced by `locations` or `defaultPolicy`. The UI shows `Hiding N universally-denied tools: …` when this happens.

- Hiding applies **everywhere**, even in directories the active policies don't cover. If `readonly` (deny by default) is the only active policy, `write` and `edit` disappear from the agent entirely. Add a permissive `defaultPolicy` if other directories should still allow them.
- Bash stays visible whenever any active policy has a non-deny bash `pattern` rule (including `$safe-bash`) or a saved approval allowing a bash pattern. It's hidden only when no active policy can allow any bash command. Saved approvals keep other tools visible too.

### The biggest specificity trap

A bash rule with **no pattern** scores by its tool glob: `"bash"` = 4.

```jsonc
{ "action": "deny",  "tool": "bash" },                    // score 4
{ "action": "allow", "tool": "bash", "pattern": "ls *" }  // score 3 → loses! `ls -la` is denied
```

Don't write bare `{ "tool": "bash" }` rules next to short patterns. Put the fallback in `defaultAction` instead, which only applies when nothing matches. Likewise `{ "tool": "*" }` scores 0 and loses to everything.

## Common intents → config

| User says | Shape |
|---|---|
| "Ask before X, allow everything else" | `defaultAction: "allow"` + `ask` rules for X |
| "Only allow these things" | `defaultAction: "deny"` + `allow` rules (+ `"$safe-bash"`) |
| "Never touch secrets, whatever tool" | `pathProtection` (not a policy rule) |
| "Just watch what it does" | `defaultAction: "log"`, or run in `inform` mode |
| "Steer it toward a better tool" | `nudge` rule with a `message`, optionally `nudgeTimeout` |
| "Catch risky things I didn't think of" | `defaultAction: "auto"` + `decisions` block |
| "Stricter in one subfolder" | a second policy on the deeper path (longest match wins) |
| "Same rules everywhere" | `defaultPolicy` |

Worked examples are in [references/recipes.md](references/recipes.md). `auto`, `decisions`, thresholds, and debugging model verdicts are covered in [references/decisions-auto.md](references/decisions-auto.md).

## Before writing: checklist

- [ ] Every `locations` value and `defaultPolicy` names a policy that exists (spelling!).
- [ ] Location keys are absolute paths or `$cwd` (`~` works, but relative paths resolve against the cwd — avoid them).
- [ ] Bash rules use `pattern`; other tools don't (it's ignored there).
- [ ] Every `nudge` has a `message`; no `defaultAction` is `nudge`.
- [ ] `$safe-bash` is written as a rule object (`{ "action": "allow", "tool": "bash", "pattern": "$safe-bash" }`), not a bare string.
- [ ] No bare `{ "tool": "bash" }` rule that would outrank short patterns.
- [ ] Patterns cover the bare command if needed (`"git status*"`, not `"git status *"`).
- [ ] If the rules should apply outside the listed locations, `defaultPolicy` is set.
- [ ] Project file: no nearer `.pi/` directory shadows it.
- [ ] Project policy with the same name as a global one: its `rules` replace the global ones. Is that intended?
- [ ] `pathProtection` globs don't use `~`.
- [ ] Not every active policy denies a tool the agent needs. Such a tool is hidden entirely, in every directory (see Tool hiding).
- [ ] Valid JSONC (a syntax error silently disables the whole file).

Trace 2–3 of the user's real commands through the precedence steps and state the expected verdict. Then write the file.

## After writing

- `/reload` or restart Pi. Config loads at session start.
- Check `~/.pi/agent/extensions/pi-controls.log` for the `loaded:` line, then each decision (`tool`, `targets`, `policyName`, `action`).
- To test safely, switch to `/controls inform`: nothing is blocked and every verdict is shown as `would-…`. Switch back with `/controls enforce`.

## Explaining "why was this blocked / asked?"

1. Find the entry in `pi-controls.log` (it lists targets, policy, action, and any `auto`/eval trace).
2. Walk the precedence steps: pathProtection? which location/policy per target? which rule won on specificity or tie? which stage/target was most restrictive?
3. For `auto`, the prompt/deny text already explains itself (`rule …: signal (probabilities); other signals; scope=… (from paths|model); targets`). See references/decisions-auto.md.
4. Suggest the smallest fix: a more specific rule, a saved approval, or a `defaultPolicy` change. Don't just loosen `defaultAction`.
