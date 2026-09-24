# super-agents-pi — RPC/API reference

This document is for RPC client authors (`pi --mode rpc`) and anyone reading a persisted Pi session
file that contains sub-agent activity. It documents every wire shape this extension produces,
byte-for-byte, grounded in the actual implementation (`src/events.ts`, `src/manager.ts`,
`src/truncate.ts`, `src/index.ts`, `src/constants.ts`). For the tool-call surface (parameters
accepted by `agent`/`agent_wait`/`agent_stop`/`agent_status`) and agent-file frontmatter, see
`README.md`.

## Transport

All sub-agent telemetry is delivered as ordinary Pi session entries, via
`pi.appendEntry("super-agents-event", payload)`:

- In RPC mode, each one shows up on stdout as a parent-session `entry_appended` event whose
  `entry.customType === "super-agents-event"` and `entry.data` is the payload documented below.
- Entries are persisted in the parent's session file like any other entry — replaying a session
  file replays the full sub-agent event history too.
- There is no separate socket or side channel: RPC clients observe everything through the normal
  parent session event stream. There is no way to steer or abort an individual child from the RPC
  protocol — only `agent_stop`, which is a regular tool call, not a bespoke control channel.

Every event carries `v: 1` (`EVENT_SCHEMA_VERSION`). Only `1` exists today; treat it as a
forward-compatibility escape hatch, not something currently variable.

Events can be disabled entirely via `superAgents.events.enabled: false` in settings — when
disabled, no `super-agents-event` entries are appended at all (lifecycle and session events alike),
though tool results, `tool_execution_update` progress, and `super-agents-result` messages are
unaffected.

## Envelope

Every payload — both `kind: "lifecycle"` and `kind: "session"` — shares this envelope:

```ts
interface EventEnvelope {
  v: 1;
  seq: number;                    // per-agentId counter, starts at 0, increments once per event
  ts: number;                     // Date.now() at emission time
  agentId: string;                // == RunRecord.id, the 8-char [a-z0-9] run id
  name: string;                   // the run's instance name (unique among concurrently-running runs)
  slug: string;                   // the agent definition's slug
  parentToolCallId: string;       // toolCallId of the `agent` tool call that started this run
  background: boolean;            // whether this run was started with background: true
  kind: "lifecycle" | "session";
  truncated: boolean;             // see "Size bounding" below — always present, not just when true
}
```

`seq` is scoped per `agentId`, not global: two concurrently-running sub-agents each start their own
`seq` at 0. There is no gap-detection field, but no event is ever silently dropped from the sequence
— only an individual event's *content* can be size-bounded (see below), never skipped outright,
with one documented exception (the extreme-truncation fallback).

## `kind: "lifecycle"`

One of three phases, emitted by `RunManager` at queue time, start-of-run, and end-of-run:

```ts
interface LifecycleEvent extends EventEnvelope {
  kind: "lifecycle";
  phase: "queued" | "started" | "finished";
  data?: StartedData | FinishedData;   // absent for "queued"
}

interface StartedData {
  model: string;                 // "provider/id", the model actually resolved — see README's model table
  thinking?: ThinkingLevel;      // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  overrideIgnored: boolean;
}

interface FinishedData {
  status: "completed" | "failed" | "aborted" | "turn_limited";
}
```

Notes:

- **`"queued"`** fires once per task, synchronously inside the `agent` tool call, before any task
  actually starts running (i.e. before semaphore acquisition). A client sees every task in one
  `agent` call queue up-front, even when concurrency limits mean only some run immediately.
- **`"started"`** fires once the child session's model/thinking has been resolved and
  `createAgentSession` has succeeded, right before the first prompt turn. `data.model` is always the
  fully-resolved `provider/id` string — inherited, pinned, or (if allowed) overridden — never the
  raw, possibly-partial value the caller originally asked for.
- **`"finished"`** fires exactly once per run, regardless of how it ended (including a run aborted
  while still waiting on the concurrency semaphore, which never gets a `"started"` event at all).
  Its `data` intentionally carries **only** `status` — full result text/error/usage are not
  duplicated onto the event stream; see the `super-agents-result` message and the `agent`/
  `agent_wait` tool results for those.

Example (`"started"`):

```json
{
  "v": 1, "seq": 1, "ts": 1758700000123,
  "agentId": "a7k2m9qz", "name": "scout", "slug": "scout",
  "parentToolCallId": "call_abc123", "background": false,
  "kind": "lifecycle", "phase": "started",
  "data": { "model": "anthropic/claude-haiku-4-5", "thinking": "low", "overrideIgnored": false },
  "truncated": false
}
```

Example (`"finished"`):

```json
{
  "v": 1, "seq": 9, "ts": 1758700004789,
  "agentId": "a7k2m9qz", "name": "scout", "slug": "scout",
  "parentToolCallId": "call_abc123", "background": false,
  "kind": "lifecycle", "phase": "finished",
  "data": { "status": "completed" },
  "truncated": false
}
```

## `kind: "session"`

Every event the child `AgentSession` emits is forwarded as `event`, **except**:

- `message_update` (streaming text/thinking deltas) — dropped; the child's `message_end` already
  carries the complete message, and forwarding every delta would flood the parent's event stream.
- `entry_appended` — dropped; that's the *child's own* in-memory session entries, meaningless to a
  client watching the *parent* session (the child session itself is never persisted).

Everything else — `turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_update`,
`tool_execution_end`, `message_end`, permission events, etc. — passes through unchanged as the SDK's
own `AgentSessionEvent` shape, just wrapped:

```ts
interface SessionEvent extends EventEnvelope {
  kind: "session";
  event: AgentSessionEvent;   // shape owned by @earendil-works/pi-coding-agent, not this package
}
```

Two variants are worth showing explicitly since they're what most client authors filter for:

```json
{
  "v": 1, "seq": 4, "ts": 1758700001456,
  "agentId": "a7k2m9qz", "name": "scout", "slug": "scout",
  "parentToolCallId": "call_abc123", "background": false,
  "kind": "session",
  "event": {
    "type": "tool_execution_start",
    "toolCallId": "child_call_1",
    "toolName": "grep",
    "args": { "pattern": "loadSettings", "path": "." }
  },
  "truncated": false
}
```

```json
{
  "v": 1, "seq": 5, "ts": 1758700001901,
  "agentId": "a7k2m9qz", "name": "scout", "slug": "scout",
  "parentToolCallId": "call_abc123", "background": false,
  "kind": "session",
  "event": {
    "type": "tool_execution_end",
    "toolCallId": "child_call_1",
    "toolName": "grep",
    "result": { "content": [{ "type": "text", "text": "src/config.ts:12:..." }] }
  },
  "truncated": false
}
```

## Size bounding (`truncated` and content shrinkage)

Every payload (envelope plus `data`/`event`) is passed through `boundJson(payload, maxEventBytes)`
(`maxEventBytes` defaults to 65536, configurable via `superAgents.maxEventBytes`) before being
appended. This is a best-effort, multi-pass shrink, not a precise byte cutoff — treat the *shape* as
unstable once truncation kicks in:

1. The payload is deep-cloned into a JSON-safe form first, independent of size: `bigint` → `string`;
   `function` → dropped (key omitted entirely); `Uint8Array`/binary → the string
   `"[binary N bytes]"`; a cyclic reference → the string `"[Circular]"`.
2. If that clone already serializes within `maxEventBytes`, it is emitted as-is with
   `truncated: false`.
3. Otherwise, strings are cut to a shrinking character budget (each becomes
   `"<prefix>…[truncated N chars]"`), and arrays longer than 200 items are cut to 200 items plus a
   trailing marker string `"[N more items truncated]"` appended as the array's last element. The
   character budget starts near `maxEventBytes / 4` and halves repeatedly until the result fits or
   the budget drops below 64 characters.
4. If even that fails to fit (pathological case, e.g. thousands of tiny fields), the **entire**
   payload is replaced with a minimal fallback:
   `{ "type": <original.type>, "truncated": true, "originalBytes": N }`. This package's envelope has
   no top-level `type` field (it has `kind`/`phase`/`event` instead), so in practice this fallback
   serializes as just `{"truncated": true, "originalBytes": N}` — **discarding `kind`, `agentId`,
   `seq`, and every other field**. A client hitting this must treat it as "an event of unknown shape
   was dropped for size" and must not assume any other field is present on that particular line.

`truncated` is **always present** on every emitted payload (`true` or `false`), not omitted when
nothing needed shrinking.

`appendEntry` failures are swallowed by the emitter — telemetry must never break a sub-agent run. A
client that never observes an expected event for a given run should not infer the run itself failed;
check the run's terminal state via `agent_status`/`agent_wait`/the `finished` lifecycle event
instead.

## Foreground progress: `tool_execution_update`

Independent of the `entry_appended`/`super-agents-event` stream above, a **foreground** `agent` tool
call (`background` omitted or `false`) also emits normal Pi `tool_execution_update` events for its
own `toolCallId` — throttled to at most once every 250ms across a batch of tasks, plus one
unconditional update whenever any task in the batch starts or finishes running:

```ts
interface ToolExecutionUpdatePayload {
  content: [{ type: "text"; text: string }];  // one "<name>: <status>" line per task in the call
  details: { runs: RunSummary[] };
}

interface RunSummary {
  id: string;
  name: string;
  slug: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted" | "turn_limited";
  model?: string;
  thinking?: string;
  usage?: RunUsage;        // present once the run has produced at least one tool call
  error?: string;
  outputPath?: string;
  durationMs?: number;     // endedAt - startedAt; undefined until both timestamps are set
}

interface RunUsage {
  turns: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}
```

This is a UI/progress convenience (what a TUI renders while `agent` is in flight); it is **not**
emitted for `background: true` calls, since those return immediately with no in-flight tool call to
update. The final `agent` tool result (once a foreground call resolves) carries the same
`details: { runs: RunSummary[] }` shape, by which point every `status` is terminal. The
`background: true` call's *immediate* return also uses this same `RunSummary` shape for its
`details.runs` (all `status: "queued"` or `"running"` at that point, since it returns without
waiting), as do `agent_wait` and `agent_status` results.

## `super-agents-result` (background delivery)

When one or more `background: true` runs finish, results are **not** pushed individually. They are
batched over a `BACKGROUND_BATCH_MS` (200ms) window — so several near-simultaneous finishes collapse
into one message — and delivered via `pi.sendMessage`:

```ts
{
  customType: "super-agents-result",
  content: string,                  // human-readable; same per-run formatting as a foreground result:
                                     // "Background sub-agent results:\n\n### <name> (<slug>) — <status> [id: <id>]\n<text>..."
  display: true,
  details: { runs: PushedRunSummary[] },
}
```

`details.runs` here uses a **different** shape than the `RunSummary` above — `RunManager`'s own
internal summarizer, not `index.ts`'s tool-facing one. It carries raw timestamps instead of a
derived `durationMs`, and adds `background`/`createdAt`/`overrideIgnored`:

```ts
interface PushedRunSummary {
  id: string;
  name: string;
  slug: string;
  background: boolean;
  status: "completed" | "failed" | "aborted" | "turn_limited";  // always terminal here
  model?: string;
  thinking?: string;
  overrideIgnored?: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outputPath?: string;
  error?: string;
  usage?: RunUsage;
}
```

Delivery timing: the message is sent with `triggerTurn: true`, and `deliverAs: "steer"` if the
parent session is mid-turn (`ctx.isIdle() === false` at push time) or `deliverAs: "followUp"`
otherwise — a background result can interrupt an in-progress parent turn rather than always waiting
for the parent to go idle.

A run claimed by an in-flight `agent_wait` call before the batch timer fires is marked delivered by
that wait and excluded from the push (no duplicate delivery). This is resolved per-run, so a batch
can end up empty — and produce no message at all — if every run in it was claimed by a concurrent
`agent_wait` before the 200ms window elapsed.

## Putting it together: one RPC transcript

For a single foreground `agent` call running one `scout` task that makes one tool call, a client
typically observes, in order, `tool_execution_update` progress events interleaved with these
`entry_appended`/`super-agents-event` entries (fields abbreviated here — see the envelope above for
what each line actually carries):

```
kind=lifecycle phase=queued
kind=lifecycle phase=started      data={model, thinking, overrideIgnored}
kind=session    event.type=turn_start
kind=session    event.type=tool_execution_start
kind=session    event.type=tool_execution_update   (optional, tool-dependent)
kind=session    event.type=tool_execution_end
kind=session    event.type=turn_end
kind=session    event.type=message_end
kind=lifecycle phase=finished      data={status: "completed"}
```

...after which the `agent` tool call itself resolves with the formatted text result and
`details: { runs: [RunSummary] }`.

For a `background: true` call, the same `entry_appended` sequence is emitted (subject to
`superAgents.events.enabled`), but there is no `tool_execution_update` progress stream, and instead
of a synchronous return, a `super-agents-result` message arrives later (batched, per the section
above) once the run reaches a terminal `finished` state.
