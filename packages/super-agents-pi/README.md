# super-agents-pi

A [pi](https://github.com/earendil-works/pi-mono) extension that lets you define your own
sub-agents in markdown files and delegate tasks to them, in-process, with their own tools, model,
extensions, and skills. Each task runs in a fresh, isolated child session and returns the
sub-agent's final answer; tasks in one call run in parallel, with an optional background mode so
the parent can keep working while sub-agents run. All child-session activity is forwarded to RPC
clients as events.

## Install

```bash
pi install npm:@mcowger/super-agents-pi
```

## Agent files

Agent definitions are markdown files with YAML frontmatter. They are discovered from two
locations, in this order:

1. **User**: `~/.pi/agent/agents/*.md` (or wherever `getAgentDir()` resolves to)
2. **Project**: `.pi/agents/*.md` (relative to the session's working directory)

Only direct children ending in `.md` are considered; subdirectories and dotfiles are skipped. The
slug is the filename without `.md` and must match `^[a-z0-9][a-z0-9_-]{0,63}$`. If a project agent
and a user agent share a slug, the **project agent wins** (whole-file replacement, not a field
merge). The resulting set is sorted by slug.

### Frontmatter fields

| Field | Type in YAML | Rule | Maps to |
|---|---|---|---|
| `description` | string | **required**, non-empty after trim. Whitespace runs are collapsed to single spaces. | `description` |
| `display_name` | string | optional, non-empty | `displayName` (default = slug) |
| `tools` | list of strings | optional. Each non-empty string, trimmed, deduped. `[]` allowed (= no tools). A non-list value is an error. | `tools` (default `read`, `grep`, `find`, `ls`) |
| `exclude_tools` | list of strings | optional | `excludeTools` |
| `extensions` | `"none"` \| `"all"` \| list of strings | optional; default `"none"` | `extensions` |
| `exclude_extensions` | list of strings | optional; only valid with `extensions: all` | `excludeExtensions` |
| `skills` | `"none"` \| `"all"` \| list of strings | optional; default `"none"` | `skills` |
| `context_files` | boolean | optional; default `false` | `contextFiles` |
| `system_prompt_mode` | `"append"` \| `"replace"` | optional; default `"append"` | `systemPromptMode` |
| `model` | string `provider/modelId` | optional; must contain a `/` with non-empty parts on both sides of the first `/` | `model` |
| `thinking` | one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | optional | `thinking` |
| `allow_model_override` | boolean | optional; default `false` | `allowModelOverride` |
| `max_turns` | integer ≥ 1 | optional; unlimited if omitted | `maxTurns` |

Unknown frontmatter fields are a hard error, to catch typos early. Sub-agents can never be given
the tools this extension itself registers (`agent`, `agent_wait`, `agent_stop`, `agent_status`) —
listing one in `tools` is an error.

Example:

```markdown
---
description: Read-only codebase explorer that answers questions with file:line references
tools: [read, grep, find, ls, bash]
model: anthropic/claude-haiku-4-5
thinking: low
max_turns: 30
---
You explore code and report findings concisely with file:line references. Never modify files.
```

## Configuration

Settings live under the `superAgents` key in `settings.json` (global `~/.pi/agent/settings.json`,
overridden per-key by project `.pi/settings.json`):

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | `8` | Maximum number of sub-agent runs executing at once (per parent session). |
| `maxTasksPerCall` | `8` | Maximum number of tasks accepted in a single `agent` tool call. |
| `graceTurns` | `3` | Extra turns allowed after `max_turns` is hit (steered first) before the run is force-aborted. |
| `maxResultBytes` | `65536` | Inline result size cap; longer results are truncated inline and written in full to an overflow file. |
| `maxEventBytes` | `65536` | Size cap for each forwarded RPC event payload. |
| `events.enabled` | `true` | Whether child-session activity is forwarded as RPC events at all. |
| `overflowDir` | `os.tmpdir()/super-agents-pi` | Directory overflow result files are written under (one subdirectory per parent session). |

```json
{
  "superAgents": {
    "maxConcurrent": 4,
    "maxTasksPerCall": 6,
    "graceTurns": 2,
    "maxResultBytes": 131072,
    "maxEventBytes": 65536,
    "events": { "enabled": true }
  }
}
```

## Tools exposed to the model

| Tool | Params | What it does |
|---|---|---|
| `agent` | `tasks: [{ agent, prompt, name?, model?, thinking? }]`, `background?: boolean` | Runs one or more tasks on sub-agents in parallel. `model`/`thinking` are only honored for agents with `allow_model_override: true`; otherwise they're ignored and the result notes `overrideIgnored`. With `background: true`, returns immediately with run ids; results are pushed automatically as a message later (or fetched with `agent_wait`). Without it, blocks and returns each agent's formatted final answer. |
| `agent_wait` | `ids?: string[]`, `timeout_seconds?: 1..3600 (default 600)` | Waits for background sub-agents to finish and returns their results. Omitting `ids` waits for all undelivered background runs. |
| `agent_stop` | `ids: string[]` (ids or names, minItems 1) | Aborts running or queued sub-agents by id or name. |
| `agent_status` | `{}` | Lists all sub-agent runs for the session with their status. Not meant to be polled — results are delivered automatically. |

## RPC event reference

For RPC client authors: every sub-agent lifecycle and child-session event is forwarded to the
parent session as a `entry_appended` event whose `entry.customType === "super-agents-event"`. The
payload shape is:

```ts
{
  v: 1,
  seq: number,              // per-agent sequence, starts at 0
  ts: number,                // Date.now()
  agentId: string,
  name: string,
  slug: string,
  parentToolCallId: string,
  background: boolean,
  kind: "lifecycle" | "session",

  // kind === "lifecycle":
  phase?: "queued" | "started" | "finished",
  data?: {
    // "started": { model, thinking }
    // "finished": { status, error?, usage, outputPath?, resultPreview }
  },

  // kind === "session": a shaped, size-bounded child AgentSessionEvent
  event?: unknown,

  truncated?: boolean,       // set when the payload was size-bounded (config.maxEventBytes)
}
```

Child `message_update` (streaming deltas) and `entry_appended` (the child's own in-memory entries)
events are dropped — everything else from the child session passes through as `kind: "session"`.
These entries are persisted in the parent's session file like any other entry.

When a background batch of runs finishes, the parent also receives a `super-agents-result` custom
message (`role: "custom"`, `customType: "super-agents-result"`) containing the formatted text and a
`details.runs` summary array, delivered as a steer or follow-up message depending on whether the
parent session is idle.

Foreground progress for an in-flight `agent` tool call is also surfaced through the normal
`tool_execution_update` event for that tool call, independent of the RPC event stream above.

## Limitations

- **In-process**: sub-agents run in the same process as the parent pi session. A crashing or
  misbehaving child extension can, in principle, affect the parent process.
- **No nesting**: sub-agents never have access to the `agent`/`agent_wait`/`agent_stop`/
  `agent_status` tools themselves, so they cannot spawn further sub-agents.
- **No client control channel**: RPC clients can observe sub-agent activity via events but cannot
  directly drive an in-flight child session (no steer/abort of an individual child from the RPC
  protocol beyond `agent_stop`).
- **`max_turns` enforcement is best-effort**: when a sub-agent hits its `max_turns`, it is first
  steered to wrap up, then force-aborted after `graceTurns` more turns if it hasn't stopped.
