# pi-subagents package guide

Guidance for working inside `packages/pi-subagents`. The root `AGENTS.md`
(monorepo commands, git rules) still applies.

This package is a personal, in-process subagent extension that presents the
`@tintinweb/pi-subagents` wire contract to Paseo, with a small set of deliberate
behavioral differences. The whole point of the tests and fixtures is to keep both
of those true.

## Required invariants

Do not change these without regenerating and reviewing the live traces. They are
pinned by `tests/playback.test.ts` and the recorded fixtures.

- **Tool surface.** Register exactly `Agent`, `get_subagent_result`, and
  `steer_subagent`, all with `exposure: "model-only"`. Never make them `direct`
  or codemode-callable.
- **`Agent` schema.** `subagent_type`, `prompt`, and `description` are required;
  `additionalProperties: false`.
- **`steer_subagent` schema.** `agent_id` and `message` required; no `cancel`.
- **Status vocabulary.** `running`, `background`, `completed`, `steered`,
  `aborted`, `stopped`, `error`. Terminal states are immutable
  (`SubagentRun.transition` throws). Never emit `failed`/`canceled`/`Done`.
- **Provider errors map to `error`.** A child whose last assistant response has
  `stopReason: "error"` transitions to `error` (`resolveTerminalStatus`), not
  `completed`. Pinned by `tests/runtime.test.ts` and the live `error` scenario.
- **Background result.** Exact tintinweb text, including the unadorned,
  whitespace-free `Output file: <path>` line. The `get_subagent_result` guidance
  line deliberately tells the model to use `wait: true` (a deviation).
- **Every child is background.** `Agent` always returns immediately with the id
  and `Output file:` line; `run_in_background` is accepted but ignored. A caller
  that wants to block uses `get_subagent_result { agent_id, wait: true }`. Only a
  background spawn exposes the transcript path at spawn time, so Paseo streams
  the child live. The foreground builders remain only for the recorded fixtures.
- **Details shape.** Background: `displayName`, `description`, `subagentType`,
  `tags`, `toolUses`, `tokens`, `durationMs`, `status`, `agentId`. Tag order is
  `twin`, `thinking: …`, `inherit context`, `background`, `max turns: …`.
- **Notification.** Custom type `subagent-notification`; `<task-notification>`
  XML (with `<context_percent>`), the `Full transcript available at:` footer, the
  `NotificationDetails` shape, and `{ deliverAs: "followUp", triggerTurn: true }`.
  Register a `subagent-notification` message renderer (using `Text` from
  `@earendil-works/pi-tui`) so the transcript shows a concise block instead of
  the raw XML content.
- **`get_subagent_result`.** Tintinweb summary text and `details: null`.
- **Lifecycle events.** `subagents:created` / `started` / `completed` / `failed` /
  `steered` with tintinweb's payloads (built by `transcript.ts`).
- **Thinking is map-driven.** Validate levels only through
  `getSupportedThinkingLevels(model)`. Never hardcode a thinking-level enum or a
  model name. A definition's unsupported level is dropped; a caller's is refused.
- **Fail closed on admission.** A refusal throws before any session/file/network
  work and creates no run and no id.
- **Depth.** `maxDepth` is finite (default `1`); per-agent `maxDepth` only
  narrows; at the ceiling the spawner is removed and gate-blocked.
- **Tool policy.** `included_tools` / `excluded_tools` freeze at admission and
  the `tool_call` gate enforces them for direct *and* codemode-nested calls.
  Keep the `Agent` tool active in every session: it carries the `prepareLoadout`
  hook that hides tools activated after session start (codemode/tool_search and
  MCP direct tools activate via `_refreshToolRegistry` → `_applyToolLoadout`).
  `filterActiveTools` must never drop `Agent`; `prepareLoadout` hides `Agent`
  itself when the policy excludes it or the depth ceiling is reached.
- **Child always loads this extension** (resolved self path) so the child's own
  gate exists. Do not remove `resolveSelfExtensionPath`.
- **Transcript path is whitespace-free.** The Paseo reader matches
  `/^Output file:\s*(\S+)$/m`.

## Required deviations

These are intentional and must remain. Do not "fix" them to match tintinweb; do
update `tests/playback.test.ts` if the behavior changes on purpose.

- **Always background; `run_in_background` ignored.** tintinweb has foreground
  (blocking, inline result) and background; we always spawn background so Paseo
  can stream the child live. If the caller passes `run_in_background` anyway, the
  agent still starts and the result notes the deprecation. Blocking is
  `get_subagent_result { wait: true }`.
- **Unknown/disabled `subagent_type` fails closed** (tool error, `details: {}`,
  no id) instead of tintinweb's fallback to `general-purpose`. Spec §4.4.
- **Depth ceiling** exists; tintinweb has no limit.
- **Frozen include/exclude tool policy + dispatch gate**; tintinweb uses
  `tools`/`isolated` only.
- **Approved-extension passing**; tintinweb inherits every parent extension.
- **Schema extras** (`included_tools`, `excluded_tools`, `extensions`) and
  `inherit_context: true` refused; tintinweb has resume/isolated/worktree/etc.
- **`prompt_mode` defaults to `append`** (gotgenes); tintinweb defaults to
  `replace`.
- **`locked`** is supported (gotgenes style); tintinweb 0.7.3 has none.
- **Transcript is the Pi session JSONL** under `<agentDir>/subagents/<run-id>/`;
  tintinweb writes a `.output` text file.
- **Extra `subagents:child:session-created` / `disposed` events** for pi-control.
- **Concurrent completions are not batched**: one `subagent-notification` per
  child; tintinweb group-joins them into one.
- **Lifecycle events**: `created`/`started` for all runs, `completed`/`failed`
  for background only; tintinweb also emits them for foreground.
- **Child context files**: children resolve `AGENTS.md`/`CLAUDE.md` for their own
  cwd via their own resource loader; the parent's `--no-context-files` does not
  propagate.
- **Operator config is `<agentDir>/pi-subagents.json`.**

`README.md` has the full table with the rationale.

## Unit testing

```sh
bun run check   # biome + tsc, run from the package
bun test
```

What each test pins:

| File | Pins |
|---|---|
| `tests/definition.test.ts` | gotgenes frontmatter parsing |
| `tests/invocation.test.ts` | caller/definition precedence and `locked` |
| `tests/model.test.ts` | model resolution (exact + fuzzy), thinking map validation |
| `tests/selectors.test.ts`, `tests/gate.test.ts` | include/exclude policy and the dispatch gate |
| `tests/lineage.test.ts` | depth ceiling and narrowing |
| `tests/extensions.test.ts` | approved-extension refs |
| `tests/transcript.test.ts` | wire text/details builders |
| `tests/tools.test.ts` | schemas and tool behavior |
| `tests/extension.test.ts` | factory wiring: registration, ceiling removal, gate |
| `tests/runtime.test.ts` | provider-error / turn-limit terminal status |
| `tests/playback.test.ts` | **contract alignment against recorded traces** |

When changing a wire builder (`src/transcript.ts`), `tests/transcript.test.ts`
and `tests/playback.test.ts` must both pass. A deliberate change to the wire
means editing the assertions **and** regenerating the fixtures (below), with the
diff reviewed.

## Using the transcripts

`tests/fixtures/tintinweb-rpc.jsonl` is a real RPC trace from
`@tintinweb/pi-subagents` — the contract oracle.
`tests/fixtures/mine-rpc.jsonl` is this extension's recorded output.

- Playback reconstructs each run from the trace's own facts (ids, paths, metrics)
  with `setSystemTime` to pin durations, then asserts the current builders
  reproduce the trace byte for byte.
- Never hand-edit a fixture. Regenerate with the live harness and re-run
  `bun test`.
- Fixtures must stay secret-free: they contain only synthetic prompts, random
  ids, `/tmp` paths, and metrics. Do not paste real session content or
  credentials into them.

## Live testing

The live harness runs the real `pi` binary in RPC mode against an isolated
`PI_CODING_AGENT_DIR`, once per target, and records the event stream.

**Never run this automatically** — it makes real, paid model calls and is
non-deterministic. Run it only when explicitly asked. Each scenario finishes in
well under a minute; the internal waits are bounded (≤150s).

```sh
# 1. Capture both sides for a scenario (writes <root>/<label>/<scenario>/)
bun tests/live/driver.ts mine <scenario>
bun tests/live/driver.ts tintinweb <scenario>

# 2. Compare at the contract level (masks run-dependent values)
bun tests/live/compare.ts <scenario>
```

Scenarios:

| Scenario | Covers | Comparable to tintinweb |
|---|---|---|
| `contract` | background/foreground/bad-type/followup | yes |
| `nested` | child spawns a grandchild at `maxDepth: 2` | no — tintinweb strips the spawner |
| `concurrent` | three background children in one turn | yes (tintinweb group-joins completions) |
| `steer` | steer a running background child | yes |
| `error` | child against the `faulty` faux provider | yes |
| `abort` | child that wraps up at its turn limit | yes |
| `mcp` | real `mcp.json` + frozen policy incl. codemode-nested | no — tintinweb has no gate |
| `shutdown` | long child, then close stdin | yes |

The comparator compares **tool results and notifications** projected onto the
contract fields; lifecycle events are informational because tintinweb emits them
inconsistently. `tests/live/agents/` holds the scenario agents and
`tests/live/fault-provider.ts` the failing provider; the driver copies both into
the isolated dir.

Files: `tests/live/driver.ts` (scenario + RPC client), `tests/live/probe.ts`
(records `pi.events` lifecycle signals), `tests/live/compare.ts` (canonical diff).

Environment (defaults in the script):

| Var | Purpose |
|---|---|
| `PI_BIN` | `pi` binary (default `~/.local/share/path-overrides/pi-local/pi`) |
| `PI_LIVE_DIR` | scratch root (default `/tmp/pi-subagents-live`) |
| `PI_LIVE_BASELINE_AGENT_DIR` | agent dir to copy provider state from (default `~/.pi/agent`) |
| `PI_LIVE_PROVIDER` / `PI_LIVE_MODEL` / `PI_LIVE_THINKING` | model under test |
| `PI_LIVE_TINTINWEB_EXT` | oracle extension ref |
| `PI_LIVE_SLICE` | chars of each mismatching record `compare.ts` prints (default 300) |

The driver copies `settings.json`, `auth.json`, `models-store.json`,
`extensions/`, and `agents/` from the baseline, symlinks `npm`/`packages`,
empties `mcp.json`, and writes both `pi-subagents.json` and `subagents.json`.
The scenario spawns background and foreground children, a bad-type call, and a
`get_subagent_result` follow-up; keep those prompts stable so traces stay
comparable.

To refresh a fixture: run `driver.ts` for the side you changed, copy
`<root>/<label>/<label>-rpc.jsonl` over the corresponding `tests/fixtures/`
file, re-run `bun test`, and review the fixture diff for anything unexpected
(secrets, unrelated content).
