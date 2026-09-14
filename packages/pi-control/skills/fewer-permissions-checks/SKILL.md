---
name: fewer-permissions-checks
description: Reviews pi-controls decision logs with jq to identify repeated ask events and safely assess whether narrower allow rules could reduce unnecessary interactive permission requests. Use when tuning pi-controls prompts or investigating frequent confirmations.
compatibility: Requires jq and pi-controls decision logging.
---

# Fewer Permissions Checks

Review the pi-controls decision log to find recurring interactive `ask` decisions. Recommend **narrow, evidence-based** policy changes that reduce routine confirmations without weakening protections for destructive, sensitive, or externally visible actions.

This skill is an assessment first: do **not** change a policy unless the user explicitly asks to apply a recommendation. If they do, use the `pi-controls` configuration workflow and ask whether the change belongs in the global or project-local config.

## 1. Locate and validate the log

By default, pi-controls writes to the agent directory. In a standard Pi installation this is `~/.pi/agent/extensions/pi-controls.log`.

```sh
LOG="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-controls.log"
test -r "$LOG" || { printf 'No readable pi-controls log at %s\n' "$LOG"; exit 1; }
jq -e . "$LOG" >/dev/null
```

The log is JSON Lines and also contains startup records, so always select records with an `action` field. Do not print raw command logs unnecessarily: commands and target paths can contain sensitive data.

## 2. Measure interactive requests

Report the time span and total `ask` events:

```sh
jq -s '
  [ .[] | select(.action == "ask") ] as $asks
  | {
      askEvents: ($asks | length),
      first: ($asks | map(.ts) | min // null),
      last: ($asks | map(.ts) | max // null)
    }
' "$LOG"
```

If `askEvents` is zero, say that the log contains no directly logged `ask` decisions and make no rule recommendation.

## 3. Find repeated requests with jq

Group exact repeated interactive calls, retaining only the fields needed for assessment:

```sh
jq -s '
  [ .[]
    | select(.action == "ask")
    | {
        ts,
        policyName,
        tool,
        command: (.command // null),
        targets: (.targets // []),
        reason: (.reason // null)
      }
  ]
  | group_by([.policyName, .tool, .command, (.targets | join("\u0000")), .reason])
  | map({
      count: length,
      policy: .[0].policyName,
      tool: .[0].tool,
      command: .[0].command,
      targets: .[0].targets,
      reason: .[0].reason,
      first: (map(.ts) | min),
      last: (map(.ts) | max)
    })
  | sort_by(-.count, .policy, .tool, .command)
' "$LOG"
```

Also summarize recurring requests by policy and tool. This finds candidates that vary in command arguments but may share a safe operation:

```sh
jq -s '
  [ .[] | select(.action == "ask") ]
  | group_by([.policyName, .tool])
  | map({
      count: length,
      policy: .[0].policyName,
      tool: .[0].tool,
      commands: ([.[].command // empty] | unique | length),
      targets: ([.[].targets[]?] | unique | length)
    })
  | sort_by(-.count, .policy, .tool)
' "$LOG"
```

Use `jq -r` only if the user wants a human-readable table. Do not use `head` as the primary review: it can hide the most frequent patterns.

## 4. Assess candidates conservatively

For every candidate with repeated evidence, inspect the active pi-controls configuration and explain why it is being prompted before proposing a rule. The log records the resolved policy name, tool, command (for bash), and targets, but **does not record** the rule that matched or whether the user selected Allow, Allow for session, or Deny.

Recommend an `allow` rule only when all of these are true:

- The same policy, tool, and operation recur, preferably at least three times.
- The action is read-only, reversible, or otherwise routine for the protected location.
- A narrow tool name or bash command pattern can express it.
- The rule cannot also match a destructive variant. Prefer a complete literal command or a constrained prefix over broad patterns such as `git *`, `rm *`, `curl *`, or `bash *`.
- It does not bypass an intentional approval boundary: deletions, force pushes, deploys, credential access, production writes, external publication, or network-changing operations should remain `ask` (or `deny`).

Do **not** recommend a rule solely because it appears often. Repeated prompts may be intentional, and a user denial is not represented in the log.

For bash, derive a pattern only from the stable safe portion of commands. For example, repeated `git status` requests can support:

```json
{ "action": "allow", "tool": "bash", "pattern": "git status" }
```

but repeated `git push origin main` requests should normally remain an explicit confirmation. For non-bash tools, propose the exact tool name, not a broad glob, unless the evidence and risk profile justify it.

If the `reason` field indicates unresolved interpreter/source analysis, do not add an allow rule merely to eliminate that prompt. Explain that doing so could bypass conservative static-analysis protection and suggest reviewing the underlying command or interpreter-analysis settings instead.

## 5. Present the result

Provide a concise report containing:

1. Log period and total `ask` events.
2. The top recurring policy/tool/command/target groups and their counts.
3. Each recommendation as a small JSON rule snippet, with the policy it belongs to and a risk rationale.
4. Calls that should remain interactive and why.
5. Any limitations: no user-choice outcome is logged; session-wide allows may reduce later repeats; and the log may not include every historical session.

If there is insufficient evidence, explicitly recommend **no change** rather than guessing.

## Applying a recommendation

Only after the user approves a recommendation, use the `pi-controls` skill to select the configuration scope, inspect the current merged policy, and add the narrow rule. Do not overwrite existing rules. Remind the user to restart Pi or run `/reload` after editing the config.
