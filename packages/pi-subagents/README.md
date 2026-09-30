# @mcowger/pi-subagents

Personal, in-process Pi subagents. One main-agent tool call spawns exactly one
child session. Parallelism comes from independent background calls.

The extension exposes the Paseo wire contract used by
`@tintinweb/pi-subagents`, so Paseo's tintinweb adapter works unchanged:

- `Agent` — spawn one child.
- `get_subagent_result` — read a run's current or terminal state.
- `steer_subagent` — send a message to a running child.

All three are registered `model-only`: the model can call them directly, but
codemode scripts cannot carry orchestration through `ctx.executeTool()`.

## Contract alignment

Verified against `@tintinweb/pi-subagents` 0.7.3 by replaying recorded Pi RPC
traces from both packages side by side (see `tests/fixtures/` and
`tests/playback.test.ts`). These are the items intended to match byte for byte:

| Surface | What aligns |
|---|---|
| Tool names / exposure | `Agent`, `get_subagent_result`, `steer_subagent`, all `model-only` |
| `Agent` required args | `subagent_type`, `prompt`, `description` |
| `steer_subagent` args | `agent_id`, `message` (no `cancel`) |
| Background result content | `Agent started in background.` … `Output file: <path>` … `Do not duplicate this agent's work.` |
| Background details | `displayName`, `description`, `subagentType`, `tags`, `toolUses`, `tokens`, `durationMs`, `status:"background"`, `agentId` |
| Tags order | `twin` (append-mode only), `thinking: <level>`, `inherit context`, `background`, `max turns: <n>` |
| Foreground result content | `Agent completed in <d>s (<uses>, <tokens>).\n\n<result>` (plus the `Output file:` line — see differences) |
| Foreground details | Same as background plus `turnCount`, `maxTurns`, `status` terminal |
| Notification | `subagent-notification`, the `<task-notification>` XML (incl. `<context_percent>`), the `Full transcript available at:` footer, `NotificationDetails`, delivered `{ deliverAs: "followUp", triggerTurn: true }` |
| `get_subagent_result` | Summary text and `details: null` |
| Status vocabulary | `running`, `background`, `completed`, `error`, `aborted`, `stopped`, `steered` — Paseo maps `completed`→completed, `error`→failed, `aborted`/`stopped`→canceled, else running |
| Lifecycle events | `subagents:created` / `started` / `completed` / `failed` / `steered` with tintinweb's payloads |
| Definition discovery | `<agentDir>/agents/<name>.md` with trusted `<cwd>/.pi/agents/<name>.md` overrides |

The playback test reconstructs each recorded run from its own facts and asserts
the current builders reproduce the trace byte for byte, so this alignment cannot
drift silently.

## Explicit differences

These are intentional and pinned by tests or by the personal design spec. They
do not affect the fields Paseo's tintinweb adapter reads.

| Area | `@tintinweb/pi-subagents` | This extension | Reason |
|---|---|---|---|
| Unknown / disabled `subagent_type` | Falls back to `general-purpose`, returns a normal completed run with an id | Fails closed before admission: tool error, `details: {}`, no id | Spec §4.4 forbids a generic fallback |
| Depth | No depth limit; children always have the spawner tools removed | Finite operator `maxDepth` (default `1`); per-agent `maxDepth` only narrows; spawner removed and gate-blocked at the ceiling | Spec §6 recursion guard with an opt-in ceiling |
| Tool policy | Definition `tools`/`disallowed_tools` allowlist and an `isolated` flag | Definition `tools` allowlist plus frozen per-call `included_tools`/`excluded_tools`, enforced by a dispatch gate for direct and codemode-nested calls | Spec §10 |
| Extension passing | Children inherit every parent extension | Children always get MCP/codemode/tool_search and only operator-approved refs named by `extensions` | Spec §11 |
| `Agent` schema extras | Accepts `max_turns`, `resume`, `isolated`, `inherit_context`, `isolation`, `schedule` | Accepts `included_tools`, `excluded_tools`, `extensions`; `max_turns`/`inherit_context` are definition-only and `inherit_context: true` refuses; unknown args rejected (`additionalProperties: false`) | Spec §4.1 |
| `get_subagent_result` schema | Has `verbose` | No `verbose` | Not implemented in v1 |
| `prompt_mode` default | `replace` when omitted | `append` when omitted (gotgenes default) | Seeds set `prompt_mode: replace` explicitly |
| `locked` | Not supported (0.7.3) | `locked: true` or a field list, gotgenes-style | Spec §4.4 pinned model/thinking |
| Transcript file | `.output` text file under a `/tmp/pi-subagents-*` directory | Pi session JSONL under `<agentDir>/subagents/<run-id>/` | Spec §8 uses the session file |
| Extra lifecycle event | — | Also emits `subagents:child:session-created` / `subagents:child:disposed` | pi-control's in-process child convention |
| Concurrent completion | Group-joins concurrent completions into one batched notification | One `subagent-notification` per child | Paseo correlates each notification individually |
| Foreground transcript pointer | No `Output file:` line on the foreground result | Appends the `Output file:` line so Paseo can attach the finished foreground child's transcript | Spec §8; Paseo reads the line from the spawn result only |
| Lifecycle event emission | Emits `completed`/`failed` for foreground runs too | Emits `created`/`started` for all runs, `completed`/`failed` for background only | Events are not read by Paseo |
| Operator config | `<agentDir>/subagents.json` (`maxConcurrent`, …) | `<agentDir>/pi-subagents.json` (`maxDepth`, `approvedExtensions`, `excludedExtensions`) | Spec §6 |

**Child context files.** Children build their own `DefaultResourceLoader`, so they
resolve `AGENTS.md` / `CLAUDE.md` for their own cwd; the parent's
`--no-context-files` flag is not propagated. A child therefore sees the project's
conventions even when the parent run suppressed them.

## What it owns

- **Locked model + thinking.** Each agent definition can lock `model` and
  `thinking` independently. A locked value is enforced exactly; a conflicting
  caller value is discarded, never clamped, and there is no fallback to the
  parent model. Supported thinking levels come from the model's own
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
- **Completion notifications.** Terminal `subagent-notification` messages use
  tintinweb's `{ deliverAs: "followUp", triggerTurn: true }` delivery.
- **Transcript visibility.** The background spawn result carries one unadorned
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

`ask_parent`, `notify_parent`, `resume`, `verbose`, worktree isolation,
scheduling, extension/skill inheritance, and the `/agents` interactive menu are
not implemented. `inherit_context: true` refuses admission.
