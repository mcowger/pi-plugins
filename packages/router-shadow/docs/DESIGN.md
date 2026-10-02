# Design: `router-shadow`

This document describes *how* to build what `REQUIREMENTS.md` specifies. The requirement IDs (R…) refer to that file.

## 1. Shape

```
┌──────────────────────── pi process ────────────────────────────────┐
│                                                                    │
│  before_agent_start ──► ShadowHandler (sync, <5 ms)                │
│                           │ snapshot: prompt, images, branch,      │
│                           │ ctx.model, session header, settings    │
│                           ▼                                        │
│                    Semaphore(2) ── full? ──► log {skipped}         │
│                           │                                        │
│                           ▼  (detached promise, AbortController)   │
│        entriesToMessages ─► buildBoundedState ─► state              │
│                           │                                        │
│              ┌────────────┼──────────────┬───────────────┐         │
│              ▼            ▼              ▼               ▼         │
│          jev-all     embed(view)    jev-zeroshot    (flash-k24)    │
│              │            │                                        │
│              │            ▼                                        │
│              │       topK(bundle) ─► jev-k24                       │
│              ▼            ▼              ▼               ▼         │
│              └──────── Promise.allSettled (8 s cap) ───┘           │
│                           ▼                                        │
│              DecisionRecord ─► appendLine(decisions-DATE.jsonl)    │
└────────────────────────────────────────────────────────────────────┘
                 │ HTTPS (Bearer PLEXUS_API_KEY)
                 ▼
            Plexus  /v1/decisions (jev-1.13)   /v1/embeddings   /v1/chat/completions
```

Everything below `ShadowHandler` is pure or I/O-injected, so experiment #3 can call `route()` from a virtual model without the shadow wrapper (R16).

## 2. Module layout (TypeScript)

```
router-shadow/
  package.json
  exemplars.json        # provided (R8)
  models.json           # provided (tier map + synonyms)
  src/
    index.ts            # extension factory: config, events, command, footer
    config.ts           # settings + env merge, validation (R12)
    snapshot.ts         # sync capture of turn inputs from ctx/event (R4.3)
    origin.ts           # origin, skill name, is_ack, actual-tier mapping (R4.5, R5)
    context/
      entries.ts        # entriesToMessages(branch, prompt, images) (R6.1, R6.2)
      bounded.ts        # buildBoundedState(messages) (R6.3)
      view.ts           # contextView(state) (R7.9)
      utf16.ts          # utf16Len, truncateUtf16 (surrogate-safe)
    scrub.ts            # scrubSecrets(text) (R9)
    bundle.ts           # loadBundle, validate, leakageGuard, topK, exemplarLines (R7.5, R7.6, R7.10, R8)
    route/
      questions.ts      # few-shot / zero-shot question builders (R7.3, R7.4)
      jev.ts            # callJev(state, question) -> CandidateResult (R7.1, R7.2, R7.7)
      embed.ts          # embed(text) -> unit vector (R7.8)
      flash.ts          # optional judge (7.4)
      route.ts          # route(input, deps) -> Record<candidateId, CandidateResult>  (R16.1)
    http.ts             # postJson with timeout, 1 retry, abort, sanitized errors (R11)
    log.ts              # DecisionRecord type, appendLine, errorLine (R10)
    status.ts           # /router-shadow status aggregation over today's log (R13)
  test/
    fixtures/           # copied from handoff/router-shadow/fixtures
    *.test.ts
```

## 3. Key types

```ts
export type Tier = "economy" | "standard" | "high" | "premium";
export const TIER_RANK: Record<Tier, number> = { economy: 0, standard: 1, high: 2, premium: 3 };

export interface Msg {               // output of entriesToMessages
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  tool_calls: { name: string; arguments: string }[] | null;
  name: string | null;               // tool name for role "tool"
  has_image: boolean;
  api: string | null;                // e.g. "openai-responses"
}

export interface BoundedState {
  task: "classify_request";
  conversation: { role: string; text: string; tool_calls?: { name: string; arguments: string }[]; name?: string }[];
  structural: { message_count: number; has_tools: false; tool_count: 0; has_images: boolean; api_type: "responses" | "messages" | "chat" | "unknown" };
}

export interface Exemplar { key: string; set: string; tier: Tier; preview: string;
  prompt_norm_hash: string; prompt_prefix_hash: string; vector: Float32Array }

export interface CandidateResult {
  tier: Tier | null; probs: Record<Tier, number> | null; tier_expected: number | null;
  confidence: number | null; latency_ms: number; input_tokens: number | null; cost: number | null;
  excluded_exemplars?: number; exemplars?: string[]; error: string | null;
}

export interface RouteInput { state: BoundedState; prompt: string; candidates: string[]; k: number }
export interface RouteDeps  { http: Http; bundle: Bundle; config: Config; signal: AbortSignal; now(): number }
export function route(input: RouteInput, deps: RouteDeps): Promise<{ embedding: { latency_ms: number | null; error: string | null }; candidates: Record<string, CandidateResult> }>;
```

## 4. Turn flow

1. **`before_agent_start`** (sync):
   - Return immediately if disabled, or if `Math.random() >= sampleRate`, or if the prompt is empty.
   - `snapshot = captureSnapshot(event, ctx)`: copies `event.prompt`, `!!event.images?.length`, `ctx.sessionManager.getBranch()` (shallow copy of the entry array), `ctx.model` (provider/id), the thinking level, the session file path, session ID, header `parentSession`, `cwd`, and `Date.now()`.
   - `if (!sem.tryAcquire()) { queueLog(skippedRecord(snapshot)); return; }`
   - `void runShadow(snapshot).finally(() => sem.release())`. **Never await it.**
2. **`runShadow`** (async, wrapped in try/catch → `errors-*.jsonl`):
   - `messages = entriesToMessages(snapshot.branch, snapshot.prompt, snapshot.hasImages)`
   - `state = buildBoundedState(messages)`; `state_hash = sha256(canonicalJson(state))`
   - `origin = classifyOrigin(snapshot)`; `actualTier = mapModel(snapshot.model)`
   - `result = await route({state, prompt, candidates, k}, deps)`, with an `AbortSignal.timeout(8000)` linked to the session's controller
   - Wait (max 1 s) for `entryIdPromise` (see 5) to resolve the user entry ID
   - `appendLine(buildRecord(...))`
3. **`route()`** (pure, I/O via `deps.http`):
   - Start `jev-all` and `jev-zeroshot` immediately; their questions don't depend on embeddings.
   - Start `embed(contextView(state))`. When it resolves: `topK(bundle, vec, 24, guard)` → start `jev-k24`, and `flash-k24` if enabled.
   - `Promise.allSettled` over the candidates. Per-call timeouts: 3 s for Jev, 2 s for embeddings, 5 s for Flash.

## 5. Resolving `entry_id` (R10.3)

At `before_agent_start`, the user message may not be in the session yet. Use a one-shot listener:
- On `message_end` (or `message_start`, whichever exposes the persisted entry ID) for the **first `user` message** of this run, record its entry ID.
- Fall back to the newest user-message entry in `ctx.sessionManager.getBranch()` whose text equals the prompt (whitespace-collapsed).
- If neither resolves within 1 s after routing completes, log `entry_id: null`. Those turns can't be blind-labeled but still count for latency and mix.

## 6. Exemplar handling

- `loadBundle()`: parse once per process, convert vectors to `Float32Array`, and check `items.length > 0`, `vector.length === 1536` and that each `tier` is valid. Freeze the result.
- `leakageGuard(prompt)`: `n = prompt.replace(/\s+/g, " ").trim().toLowerCase()`; returns `{full: sha256hex(n), prefix: sha256hex(n.slice(0, 200))}`. An exemplar is excluded if `ex.prompt_norm_hash === full || ex.prompt_prefix_hash === prefix`.
- `exemplarLines(list) = list.map(e => \`- [${e.tier}] ${e.preview}\`).join("\n")`
- `jev-all`: every item in bundle order, guard applied.
- `topK(vec, k)`: dot product with each item's unit vector (the query vector is normalized first). Sort descending, guard applied, take `k`. Ties keep bundle order (stable sort).
- Hashing: Node `crypto.createHash("sha256").update(str, "utf8").digest("hex")`.

## 7. HTTP (`http.ts`)

```ts
postJson(path: "/v1/decisions" | "/v1/embeddings" | "/v1/chat/completions", body, { timeoutMs, signal }): Promise<{ json: any; ms: number }>
```
- `base = apiBase.replace(/\/+$/, "")`; `url = base.endsWith("/v1") ? base + path.slice(3) : base + path`.
- `fetch` with `redirect: "error"`, which never forwards the bearer token on a redirect. Use `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`.
- Retry once after 300 ms on 429/502/503/504 or a network error, only if time remains.
- Errors are reduced to `"http_<status>" | "timeout" | "network" | "invalid_json" | "invalid_answer"`, plus at most 120 characters of the server message with the key and host removed.

## 8. Scrubbing (`scrub.ts`)

Hand-rolled scanning loop, not `String.replace`, because of the rescan rule (R9.1):

```ts
const ASSIGN = /(["']?[A-Za-z_][A-Za-z0-9_.\-]*)(["']?\s*[:=]\s*)("(?:[^"]*)"|'(?:[^']*)'|[^\s,;}\n]+)/y; // sticky
let out = "", i = 0;
while (i < s.length) {
  const m = findNextAssign(s, i);              // regex with lastIndex search (non-sticky /g), from i
  if (!m) { out += s.slice(i); break; }
  if (isSecretName(m[1])) { out += s.slice(i, m.index) + m[1] + m[2] + redactValue(m[3]); i = m.index + m[0].length; }
  else { const valueStart = m.index + m[1].length + m[2].length; out += s.slice(i, valueStart); i = valueStart; }
}
```
Then the Bearer replace, then the token-prefix replace (R9.2–R9.4). Validate against `fixtures/scrub.json`.

## 9. UTF-16 truncation (`utf16.ts`)

JS strings are already UTF-16, so `s.length` is the unit count. To truncate to `max`:
- Walk code points with `for (const ch of s)`.
- Accumulate `ch.length` (1 or 2). Stop before exceeding `max`.
- `removed = s.length - kept.length`
- Result: `kept + "…[truncated " + removed + "]"`.

`fixtures/bounded_state.json` includes the surrogate-boundary case.

## 10. Logging (`log.ts`)

- Path: `${logDir}/decisions-${new Date().toISOString().slice(0, 10)}.jsonl`. Create the directory with mode `0700` and files with mode `0600`.
- Write with `fs.promises.appendFile(path, JSON.stringify(record) + "\n", { flag: "a" })`. Each record is one write call; lines stay well under the 4 KB pipe limit except with large `exemplars` arrays (24 keys ≈ 400 bytes, fine).
- `errors-*.jsonl`: `{ts, where, error}` only.
- `canonicalJson`: recursive key sort, then `JSON.stringify` with no spaces. Used for `state_hash`, which the experiment repo can recompute from a rebuilt state (R14 #9).

## 11. Origin (`origin.ts`)

```ts
isSubagentSession = !!header.parentSession || subagentRegistry.has(sessionId)
origin = isSubagentSession || /^(\s*task:\s*you are|.*you are a delegated subagent|.*message type:\s*new_task)/is.test(prompt) ? "subagent"
       : inputSource === "extension" ? "extension"
       : inputSource in {interactive, rpc} ? "human" : "unknown";
skill_name = prompt.match(/^\s*<skill name="([^"]+)"/)?.[1] ?? null   // if set, origin "subagent" too (R5.2)
```
- `subagentRegistry`: if the installed subagent extension emits a `pi.events` event on child creation, record the session ID. Otherwise rely on `parentSession`. Check this against the subagent extension you actually use.
- `inputSource`: use the `input` event, which fires before `before_agent_start`, to remember the source of the next prompt, if pi exposes one. Otherwise treat it as `unknown` and rely on the prefixes.

## 12. Status command (`status.ts`)

Read today's decisions file, streaming line by line, and compute what R13 asks for. Output a compact table through `ctx.ui.notify`, or print it in non-UI modes.

## 13. Testing strategy

- **Fixture-driven unit tests:** run every file in `test/fixtures/` through the matching function and deep-equal the expected output (R14 #1–5).
- **Handler timing test:** a fake `ctx` plus a hanging `http` mock. Assert that the handler returns in under 5 ms and that a `timeout` record appears after the caps elapse (fake timers).
- **Privacy test:** put a sentinel in the prompt, run the full flow with mocked HTTP, and assert the sentinel is absent from every written byte.
- **Live smoke test:** with `ROUTER_SHADOW_ENABLED=1`, run three real pi turns. Check that one record per turn appears with all three candidates populated, then run the experiment repo's `scripts/shadow_report.py report`.

## 14. Rollout

1. Install the extension in your normal pi profile, with all three default candidates on.
2. Day 1: run `/router-shadow status`. Check the error rate is ≤2% and `jev-all` latency is 90th percentile ≤400 ms. Run `shadow_report.py sample` and spot-check that rebuilt contexts look right.
3. Days 1–14: run the daily blind sample (5 items) in the experiment repo chat, and a weekly `report`.
4. Day 14: compare against the go/no-go criteria in REQUIREMENTS section 15, then decide on live routing (R16).

## 15. Known risks

| Risk | Mitigation |
|---|---|
| `jev-all` (113 exemplars, fixed order) is untested offline | It runs next to `jev-k24`, the tested best; shadow data decides |
| Most of the actual-model data comes from session defaults or subagent configs, not deliberate choices | Blind labels are the headline metric; actual-agreement is restricted to human + `user_selection` |
| Premium is rare (9 of 113 exemplars) | Watch `vs blind` on premium separately; add premium exemplars from blind labels when the bundle is refreshed |
| Prompt changes from a pi upgrade (role names, compaction format) | Fixture tests in CI; the R14 #9 parity check against the experiment repo |
| Secrets in session content | Scrub before every send (R9); nothing textual is logged (R10.5) |
