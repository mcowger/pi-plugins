# pi-subagents design

Why this package is shaped the way it is: the `@tintinweb/pi-subagents` wire
contract it presents to Paseo, the parts pinned to match that contract byte for
byte, and the deliberate differences. This is maintainer/reference material.

- User guide: [README.md](README.md)
- Contributor invariants and testing: [AGENTS.md](AGENTS.md)

## Goal

A personal, in-process Pi subagent extension. One `Agent` tool call spawns
exactly one child session with its own model/thinking, tool policy, and
transcript; the parent keeps working while the child runs. It exposes the Paseo
wire contract so `@tintinweb/pi-subagents`'s Paseo adapter works unchanged, while
adding locked model/thinking, a finite depth ceiling, and a frozen tool policy.

## Wire contract

Paseo dispatches exactly three tool names — `Agent`, `get_subagent_result`, and
`steer_subagent` — and correlates runs by the ids those tools return. All three
are registered `model-only`: the model calls them directly, but codemode scripts
cannot carry orchestration through `ctx.executeTool()`.

## Contract alignment

Verified against `@tintinweb/pi-subagents` 0.7.3 by replaying recorded Pi RPC
traces from both packages side by side (see `tests/fixtures/` and
`tests/playback.test.ts`). These traces pin the shared tool surface; intentional
differences are listed below.

| Surface | What aligns |
|---|---|
| Tool names / exposure | `Agent`, `get_subagent_result`, `steer_subagent`, all `model-only` |
| `Agent` required args | `subagent_type`, `prompt`, `description` |
| `steer_subagent` args | `agent_id`, `message` (no `cancel`) |
| Background result content | `Agent started in background.` … `Output file: <path>` … `Do not duplicate this agent's work.` (the `get_subagent_result` guidance line differs — see differences) |
| Background details | `displayName`, `description`, `subagentType`, `tags`, `toolUses`, `tokens`, `durationMs`, `status:"background"`, `agentId` |
| Tags order | `twin` (append-mode only), `thinking: <level>`, `inherit context`, `background`, `max turns: <n>` |
| Notification | `subagent-notification` custom type, the `NotificationDetails` fields (id/status/outputFile/…), delivered `{ deliverAs: "followUp", triggerTurn: true }` (content and suppression differ — see differences) |
| `get_subagent_result` | Summary text and `details: null` |
| Status vocabulary | `running`, `background`, `completed`, `error`, `aborted`, `stopped`, `steered`; internal runs keep this vocabulary, terminal notification details map `steered` to `completed` for Paseo, and `get_subagent_result` keeps `steered`. |
| Lifecycle events | `subagents:created` / `started` / `completed` / `failed` / `steered` with tintinweb's payloads |
| Definition discovery | `<agentDir>/agents/<name>.md` with trusted `<cwd>/.pi/agents/<name>.md` overrides |

The playback test reconstructs each recorded run from its own facts and asserts
the current builders reproduce the trace byte for byte, so this alignment cannot
drift silently.

## Explicit differences

These are intentional and pinned by tests or by the personal design spec. The
Paseo-facing notification keeps its existing fields; the status value below is
normalized to Paseo's provider-subagent enum.

| Area | `@tintinweb/pi-subagents` | This extension | Reason |
|---|---|---|---|
| Unknown / disabled `subagent_type` | Falls back to `general-purpose`, returns a normal completed run with an id | Fails closed before admission: tool error, `details: {}`, no id | Spec §4.4 forbids a generic fallback |
| Depth | No depth limit; children always have the spawner tools removed | Finite operator `maxDepth` (default `1`); per-agent `maxDepth` only narrows; spawner removed and gate-blocked at the ceiling | Spec §6 recursion guard with an opt-in ceiling |
| Tool policy | Definition `tools`/`disallowed_tools` allowlist and an `isolated` flag | Definition `tools` allowlist plus frozen per-call `included_tools`/`excluded_tools`, enforced by a dispatch gate for direct and codemode-nested calls | Spec §10 |
| Extension passing | Children inherit every parent extension | Children always get MCP/codemode/tool_search and only operator-approved refs named by `extensions` | Spec §11 |
| `Agent` schema extras | Accepts `max_turns`, `resume`, `isolated`, `inherit_context`, `isolation`, `schedule` | Accepts `included_tools`, `excluded_tools`, `extensions`; `max_turns`/`inherit_context` are definition-only and `inherit_context: true` refuses; unknown args rejected (`additionalProperties: false`) | Spec §4.1 |
| `Agent` description | Static | `prepareLoadout` appends the discovered, enabled agent names + descriptions (`buildAgentCatalog`) | Tool descriptions are re-sent every request, so the available `subagent_type` values stay visible after long runs and compaction; Paseo maps tools by name, so the text is contract-neutral |
| `get_subagent_result` schema | Has `verbose` | No `verbose` | Not implemented in v1 |
| `prompt_mode` default | `replace` when omitted | `append` when omitted (gotgenes default) | Seeds set `prompt_mode: replace` explicitly |
| `locked` | Not supported (0.7.3) | `locked: true` or a field list, gotgenes-style | Spec §4.4 pinned model/thinking |
| Terminal notification status | `steered` | `completed` | `steered` is the terminal soft-turn-limit result; Paseo's provider-subagent enum has no `steered`. The notification text and `get_subagent_result` retain the wrap-up status. |
| Transcript file | `.output` text file under a `/tmp/pi-subagents-*` directory | Pi session JSONL under `<agentDir>/subagents/<run-id>/` | Spec §8 uses the session file |
| Extra lifecycle event | — | Also emits `subagents:child:session-created` / `subagents:child:disposed` | pi-control's in-process child convention |
| Concurrent completion | Group-joins concurrent completions into one batched notification | One `subagent-notification` per child | Paseo correlates each notification individually |
| Spawn mode | Foreground (blocking, inline result) and background | Always background; `run_in_background` is accepted but ignored (the result notes the deprecation); block for the result with `get_subagent_result { agent_id, wait: true }` | Only a background spawn exposes the transcript path at spawn time, so Paseo can stream the child live |
| Notification content | `<task-notification>` XML block with the result and transcript footer | Short code-fenced block: status line, `Result: <result.md path>`, `Transcript: <path>`. The result is written to `result.md` beside the transcript and never inlined; falls back to a `get_subagent_result` pointer if the write fails. Structured fields stay in `details` | Keeps the parent's context readable; the parent reads the file on demand. Paseo renders the text as a timeline item, so XML would be shown verbatim |
| Notification timing | Always notifies and wakes on completion | Always sends the notification (Paseo needs `details` to mark the child finished), but a result already claimed by `get_subagent_result` (`wait: true`, or a terminal read) is delivered with `triggerTurn: false`, so no extra turn | Avoids the redundant wake-up turn without stranding the child's UI state |
| Child summary | No built-in instruction | A fixed instruction is appended to the child's system prompt to end with a self-contained summary | The final assistant text is what the parent receives back |
| Lifecycle event emission | Emits `completed`/`failed` for foreground runs too | Emits `created`/`started` for all runs, `completed`/`failed` for background only | Events are not read by Paseo |
| Operator config | `<agentDir>/subagents.json` (`maxConcurrent`, …) | `<agentDir>/pi-subagents.json` (`maxDepth`, `approvedExtensions`, `excludedExtensions`) | Spec §6 |
| Child timeout | No per-child timeout | `timeout_minutes` frontmatter per definition; no operator default | Bounds a hung child without a global cap |

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
- **Per-definition child timeout.** `timeout_minutes` aborts a child after that
  many wall-clock minutes (status `aborted`, reason `timeout of N minutes
  reached`). There is no operator default. `requestTermination` aborts the run's
  `AbortController`, and `spawnSubagent` wires that signal to `session.abort()`, so
  a timeout — or aborting a `get_subagent_result { wait: true }` caller — actually
  stops the child session rather than leaving it running.
- **Completion notifications.** Terminal `subagent-notification` messages use
  tintinweb's `{ deliverAs: "followUp", triggerTurn: true }` delivery.
- **Transcript visibility.** Every child runs in the background, so the spawn
  result carries one unadorned `Output file: <path>` line and Paseo streams it
  live. Child sessions persist to their own JSONL file under
  `<agentDir>/subagents/<run-id>/`.

**Child context files.** Children build their own `DefaultResourceLoader`, so they
resolve `AGENTS.md` / `CLAUDE.md` for their own cwd; the parent's
`--no-context-files` flag is not propagated. A child therefore sees the project's
conventions even when the parent run suppressed them.

## Where the behavior is pinned

- `tests/playback.test.ts` replays the recorded `tests/fixtures/` traces and
  asserts the wire builders reproduce them, so the contract alignment cannot
  drift silently.
- `tests/live/compare.ts` drives the real `pi` binary for this extension and for
  `@tintinweb/pi-subagents` and compares the contract fields.

The invariants, unit-test map, transcript policy, and live-harness usage live in
[AGENTS.md](AGENTS.md).
