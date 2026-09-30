# @mcowger/pi-subagents

Personal, in-process Pi subagents. One main-agent tool call spawns exactly one
child session. Parallelism comes from independent background calls.

This extension implements the wire contract expected by Paseo's
`@tintinweb/pi-subagents` adapter without changing Pi or Paseo:

- `Agent` — spawn one child.
- `get_subagent_result` — read a run's current or terminal state.
- `steer_subagent` — send a message to, or cancel, a running child.

The three tools are registered `model-only`: the model can call them directly,
but codemode scripts cannot carry orchestration through `ctx.executeTool()`.

## What it owns

- **Locked model + thinking.** Each agent definition can lock `model` and
  `thinking` independently. A locked value is enforced exactly; a conflicting
  caller value is refused, never clamped, and there is no fallback to the parent
  model. Supported thinking levels come from the model's own
  `thinkingLevelMap` at runtime; no level or model name is hardcoded.
- **Depth ceiling.** Root is depth 0. `maxDepth` is a finite operator setting
  (default `1`). A per-agent `maxDepth` only narrows the inherited lineage. At
  the ceiling the spawner tool is removed from the model's tool set and the
  dispatch gate refuses it anyway.
- **Frozen tool policy.** `included_tools` / `excluded_tools` freeze at
  admission. The dispatch gate enforces the policy for direct calls and for
  calls codemode scripts make with `ctx.executeTool()`, including underlying MCP
  calls. Exclusion always wins; `included_tools: []` means no tools at all.
- **Approved extension passing.** The child always receives the mandatory MCP,
  codemode, and tool_search extensions. Extra extensions come only from
  operator-approved refs.
- **Deferred notifications.** Terminal `subagent-notification` messages are
  queued with `triggerTurn: false`, so a zero-duration child cannot lose its
  update to the spawn-result race.
- **Transcript visibility.** The spawn result carries one unadorned
  `Output file: <path>` line. Child sessions persist to their own JSONL file
  under `<agentDir>/subagents/<run-id>/`.

## Agent definitions

Definitions live at `<agentDir>/agents/<name>.md` (default
`~/.pi/agent/agents/`) with trusted project overrides at `<cwd>/.pi/agents/`.
Any name is allowed; the filename is the agent type. The frontmatter follows the
`@gotgenes/pi-subagents` format:

| Field | Default | Meaning |
|---|---|---|
| `description` | filename | Human-facing description |
| `display_name` | — | UI display name |
| `tools` | seven built-ins | Complete allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, or extension/MCP tool names. `none` means no tools. Comma scalar, flow list, or block list |
| `model` | inherit parent | Exact `provider/modelId` or a fuzzy name |
| `thinking` | inherit parent | Validated against the resolved model's `thinkingLevelMap` |
| `max_turns` | unlimited | Soft cap, then a five-turn grace window before abort |
| `prompt_mode` | `append` | `append` wraps the body in `<agent_instructions>`; `replace` appends it raw |
| `inherit_context` | `false` | Not supported in v1; `true` refuses admission |
| `run_in_background` | `false` | Default background mode for this agent |
| `locked` | — | `true` withholds every field the file sets; a list withholds the named fields (`model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`) |
| `enabled` | `true` | `false` disables the definition |
| `extensions` | inherit approved | Approved extension refs; `[]` selects none |
| `maxDepth` | inherit | Per-agent depth ceiling that only narrows |

A `locked:` declaration is the only case where a spawn caller's value is
discarded; otherwise the caller wins and the definition fills the gaps. The
definition body is appended to the child's system prompt per `prompt_mode`.

Thinking levels are never hardcoded. A definition's unsupported level is
dropped so the child inherits rather than clamping to `off`; a caller's
unsupported level is refused. The resolved model and level are asserted after
the child binds and before its first request.

Example (`explore.md`):

```markdown
---
description: Read-only recon of a repo or directory tree.
tools: read, bash, grep, find, ls
model: plexus/deepseek-v4.1-flash
thinking: off
max_turns: 40
prompt_mode: replace
locked: [model, thinking]
---

You are a read-only exploration agent.
```

## Tool policy

The definition's `tools` is the child's complete allowlist. A spawn call's
`included_tools` overrides it; `excluded_tools` always wins. The dispatch gate
enforces the same frozen policy for direct calls and for calls codemode scripts
make with `ctx.executeTool()`, including underlying MCP calls. `tools: none` or
`included_tools: []` means no tools at all.

## Operator config

`<agentDir>/pi-subagents.json`:

```json
{
  "maxDepth": 1,
  "approvedExtensions": {
    "research": "/absolute/path/to/research-extension.ts"
  },
  "excludedExtensions": []
}
```

`maxDepth` must be a finite non-negative integer. Approved refs are
operator-supplied only; the model can never name a raw module path.

## Not in v1

`ask_parent`, `notify_parent`, and resume are not implemented.
