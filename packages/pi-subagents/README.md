# @mcowger/pi-subagents

Personal, in-process subagents for Pi. One `Agent` tool call spawns exactly one
child session with its own model/thinking, tool policy, and transcript; the
parent keeps working while the child runs, and parallelism comes from independent
calls.

The extension speaks the `@tintinweb/pi-subagents` wire contract, so Paseo's
tintinweb adapter drives it unchanged. Locked model/thinking, a finite depth
ceiling, and a frozen tool policy are deliberate additions — the contract
alignment and every intentional difference are documented in
[DESIGN.md](DESIGN.md).

## Installation

`@mcowger/pi-subagents` is not published to npm yet; install it from the
repository:

```sh
git clone https://github.com/mcowger/pi-plugins.git
pi install ./pi-plugins/packages/pi-subagents
```

To try the checkout for one run without installing it:

```sh
pi --extension /path/to/pi-plugins/packages/pi-subagents/index.ts
```

Restart Pi or run `/reload` after installing. The three tools appear as `Agent`,
`get_subagent_result`, and `steer_subagent`.

## Quick start

```text
Agent {
  subagent_type: "explore",
  prompt: "Map the auth flow and report the entry points.",
  description: "Recon auth"
}
```

Every child runs in the background. The spawn result returns the run id and its
transcript path immediately; block for the result when you need it:

```text
get_subagent_result { agent_id: "<id-from-the-spawn-result>", wait: true }
```

A completion notification carries the child's final summary, so you can also keep
working and be woken when it finishes.

## Tools

All three tools are `model-only`: the model can call them directly, but codemode
scripts cannot carry orchestration through `ctx.executeTool()`.

### `Agent`

Spawn exactly one child.

| Arg | Required | Meaning |
|---|---|---|
| `subagent_type` | yes | Agent definition name (see [Agent definitions](#agent-definitions)) |
| `prompt` | yes | The task for the child |
| `description` | yes | Short human-facing description |
| `included_tools` | no | Per-call allowlist; `[]` means no tools |
| `excluded_tools` | no | Per-call denylist; always wins over inclusion |
| `extensions` | no | Operator-approved extension names for this child |
| `model` | no | Exact `provider/modelId` or a fuzzy name |
| `thinking` | no | Level from the resolved model's supported levels |
| `run_in_background` | no | Accepted for compatibility but **ignored** — every child is background |

The spawn result carries `Agent ID: <id>` and one unadorned
`Output file: <path>` line (the child's Pi session JSONL). Paseo uses that line
to stream the child's transcript live.

### `get_subagent_result`

Read a run's current or terminal state, or block for it.

| Arg | Required | Meaning |
|---|---|---|
| `agent_id` | yes | The id from the spawn result |
| `wait` | no | Await terminal state without advancing the child |

`wait: true` returns the result as a tool result and suppresses the notification's
wake-up turn (the notification is still sent so the UI clears the run). Aborting
the turn while the wait is pending cancels the child instead of orphaning it.

### `steer_subagent`

Send a message to a running child; it is delivered after the child's current tool
execution.

| Arg | Required | Meaning |
|---|---|---|
| `agent_id` | yes | The id from the spawn result |
| `message` | yes | Text to inject into the child |

### Notifications and transcripts

On completion the child emits a `subagent-notification` custom message: a status
line plus the child's final summary (in full up to ~10k characters, then a
truncation note). Every child is instructed to end with a self-contained summary,
because that text is what the parent receives back. Child sessions persist under
`<agentDir>/subagents/<run-id>/`.

## Agent definitions

Definitions live at `<agentDir>/agents/<name>.md` (default `~/.pi/agent/agents/`)
with trusted project overrides at `<cwd>/.pi/agents/`. Any name is allowed; the
filename is the agent type. The available names and descriptions are injected
into the `Agent` tool description each session, so the model sees them even after
a long run or a compaction.

The frontmatter follows the `@gotgenes/pi-subagents` format:

| Field | Default | Meaning |
|---|---|---|
| `description` | filename | Human-facing description |
| `display_name` | — | UI display name |
| `tools` | seven built-ins | Complete allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, or extension/MCP tool names. `none` means no tools. Comma scalar, flow list, or block list |
| `model` | inherit parent | Exact `provider/modelId` or a fuzzy name |
| `thinking` | inherit parent | Validated against the resolved model's `thinkingLevelMap` |
| `max_turns` | unlimited | Soft cap, then a five-turn grace window before abort |
| `timeout_minutes` | disabled | Abort the child after this many wall-clock minutes (any positive number); a timed-out or cancelled wait aborts the child too |
| `prompt_mode` | `append` | `append` wraps the body in `<agent_instructions>`; `replace` appends it raw |
| `inherit_context` | `false` | Not supported in v1; `true` refuses admission |
| `run_in_background` | ignored | Accepted for compatibility; children always run in the background |
| `locked` | — | `true` withholds every field the file sets; a list withholds the named fields (`model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`) |
| `enabled` | `true` | `false` disables the definition |
| `extensions` | inherit approved | Approved extension refs; `[]` selects none |
| `maxDepth` | inherit | Per-agent depth ceiling that only narrows |

A `locked:` declaration is the only case where a spawn caller's value is
discarded; otherwise the caller wins and the definition fills the gaps. The
definition body is appended to the child's system prompt per `prompt_mode`.

Thinking levels are never hardcoded. A definition's unsupported level is dropped
so the child inherits rather than clamping to `off`; a caller's unsupported level
is refused. The resolved model and level are asserted after the child binds and
before its first request.

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

## Operator configuration

`<agentDir>/pi-subagents.json` (default `~/.pi/agent/pi-subagents.json`), read at
session start. A missing file uses the defaults; an invalid file warns and falls
back to the defaults.

```json
{
  "maxDepth": 1,
  "approvedExtensions": {
    "research": "/absolute/path/to/research-extension.ts"
  },
  "excludedExtensions": []
}
```

| Field | Default | Meaning |
|---|---|---|
| `maxDepth` | `1` | Global, finite, non-negative depth ceiling. Root is depth 0; a child is depth 1. There is no unbounded mode |
| `approvedExtensions` | `{}` | Operator-chosen name → extension ref. Only these names are accepted in a spawn's `extensions`; the model can never name a raw module path |
| `excludedExtensions` | `[]` | Approved refs removed from child inheritance and selection |

## Not in v1

`ask_parent`, `notify_parent`, `resume`, `verbose`, worktree isolation,
scheduling, extension/skill inheritance, and the `/agents` interactive menu are
not implemented. `inherit_context: true` refuses admission.

## Design and development

- [DESIGN.md](DESIGN.md) — the wire contract, contract-alignment and
  explicit-difference tables, and what the extension owns.
- [AGENTS.md](AGENTS.md) — maintainer invariants, the unit-test map, transcript
  policy, and the live-harness usage.
