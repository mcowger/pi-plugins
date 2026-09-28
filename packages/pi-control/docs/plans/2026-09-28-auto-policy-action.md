# `auto` Policy Action — Model-Evaluated Fallthrough

**Date:** 2026-09-28
**Status:** Implemented
**Scope:** `pi-controls` extension — a new `auto` action that defers an otherwise-unmatched tool call to the Decisions API for a capability/blast-radius evaluation, mapping the model's answers to `allow` / `ask` / `deny` through a deterministic rule table.

---

## 1. Goal and non-goals

**Goal:** give a policy a final fallthrough that reasons about *any* tool call instead of silently allowing it. When the winning action for a tool call is `auto`, pi-controls assembles the call's context, sends it with a fixed capability/blast-radius question set to the Decisions model configured under `decisions`, and maps the answers to a terminal action. This lets a permissive default (`defaultAction: "auto"`) catch risky calls that no pattern or path rule anticipated, without hand-maintaining a rule for every tool.

**Non-goals (v1):**
- Replacing explicit rules. `pathProtection` and matched rules always run first; `auto` is a deferral of last resort.
- Letting the model freely judge "should this be allowed". The model answers structured questions; code decides (mirrors eval classification, `2026-09-22-decisions-eval-classification.md`).
- Conversation-aware intent adjudication. The prompt and recent history are **grounding context** only — no dedicated `intent` question, no downgrade path.
- Secret redaction of the outgoing request.
- Per-session spend caps or request budgets.
- A separate transport/auth/model for auto. It shares the `decisions` block.

No migration or backward compatibility is required (standing project rule).

---

## 2. Semantics and placement

`auto` is a first-class member of the `Action` union. It is legal on any rule (`{ "action": "auto", "tool": "github_*" }`) and as a policy `defaultAction`.

**It is not itself an enforcement outcome.** Wherever actions are combined or matched, `auto` behaves as a deferral token that is resolved to `allow` / `ask` / `deny` *after* combination:

- Cross-policy combination (`mostRestrictive`) ranks it between `ask` and `log`:
  `deny > ask > auto > log > nudge > allow`.
  So explicit `deny`/`ask` from any target beat a model verdict, `auto` beats a bare `allow`/`log`/`nudge`, and a call is evaluated **once per tool call**, on the combined result, with every target and policy name in the state.
- Within-policy rule tie-breaking (`ACTION_PRIORITY`) keeps explicit rules ahead of the deferral: `auto` is appended below `log`, so an explicit `allow`/`nudge`/`ask`/`deny`/`log` rule wins a same-specificity tie and `auto` only wins when no more specific or same-specificity explicit rule matched. (The two orderings serve different purposes and intentionally differ.)

**Evaluation count:** exactly one Decisions request per tool call in which the combined action is `auto`. Multiple `auto` targets are not resolved individually.

**Known edge case (documented, not fixed):** when one target resolves to `auto` and another to `nudge`, `mostRestrictive` picks `auto` and the nudge message is dropped for that call. A call matched only by a `log`/`nudge` rule *within a single policy* is unaffected — the explicit rule wins the policy match and auto never runs.

**Remote writes:** deliberately **not** special-cased. A remote mutation (PR/merge/force-push/posted API change) with `destructive=no`, `data_sensitivity=ordinary`, `network=yes` fires no rule and is allowed under a permissive auto fallthrough. Sites that want a gate put an explicit `ask` rule on those patterns (the sample config's `ask git push*` convention).

---

## 3. Decisions API reuse

Same endpoint, auth, and request/response shape as eval classification (`src/utils/decisions.ts`, which uses the official `@typesafe-ai/sdk` client; `decisions.url` stays the exact endpoint by rewriting the SDK's fixed `/v1/systemone` path) :

- `POST {decisions.url}`, `Authorization: Bearer $<tokenEnv>`, `X-Title: pi-controls`, `{ model, state, questions, session_id }`.
- `noul` → `{ noul: p }` (P(true)); `choice` → `{ choice, confidence, probabilities }`.
- Failures throw `DecisionsError` (`auth` | `http` | `timeout` | `network` | `malformed`) and are mapped via `decisions.errorAction` (default `ask`).

The auto request is a distinct call from eval classification. **Auto is skipped only when every stage that produced the `auto` verdict was itself eval-classified** (`autoSkipped` reason `eval-classified`): the eval classifier is the specialist for those stages, which avoids double billing. A command that mixes an eval stage with a non-eval stage is still evaluated for the non-eval part.

---

## 4. Trigger scope

Auto runs for **every tool** — bash, `read`, `write`, `edit`, `grep`, `find`, `ls`, and custom/MCP tools (`CustomToolCallEvent`) — subject to the same guards as eval:

| Condition | Behavior |
|---|---|
| Combined action is not `auto` | No call; normal enforcement. |
| `ignore` mode | No call (existing short-circuit). |
| Session allowlist covers the call | No call; allowed. |
| Saved approval rule matches every target | The approval's `allow` wins the match; no call. Auto still runs when any target is unapproved and remains `auto`. |
| Every `auto`-producing stage was eval-classified | Auto skipped (reason `eval-classified`). |
| `decisions` block absent/unconfigured | No call; falls back to `ask` + once-per-session warning. |
| API error/timeout/auth/malformed | `decisions.errorAction` (default `ask`). |
| `inform` mode | Call the API; report `would-<action>` with rationale (faithful preview, consistent with eval). |

---

## 5. State

One request per tool call. Facts only — never the location verdict or matched policy internals (declined for v1).

```jsonc
{
  "tool": "write",
  "input": {
    "path": "/home/user/proj/src/main.ts",
    "content_bytes": 18432,
    "content_preview": "…first 4 KiB…",
    "content_truncated": true
  },
  "tool_description": "Write a file to disk. …",   // from pi.getAllTools(); omitted when unavailable
  "tool_schema": { /* parameter schema */ },        // omitted when unavailable
  "cwd": "/home/user/proj",
  "targets": ["/home/user/proj/src/main.ts"],       // resolved from the call, as today
  "user_prompt": "…current turn's user prompt (truncated)…",
  "conversation": [                                 // ~6 turns, summaries only
    { "role": "user", "text": "…" },
    { "role": "assistant", "text": "…" },
    { "role": "tool", "tool": "bash", "summary": "git status" }
  ],
  "scope_note": "Judge the tool call described by `tool`, `input`, and `execution_context`. The user_prompt and conversation are context for what the call is meant to accomplish — they do not add effects the call itself does not have."
}
```

**Input normalization (`normalizeToolInput`), per tool:**

| Tool | Sent |
|---|---|
| `bash` | full `command` (truncated to `maxInputBytes`) |
| `read` | `path`, `offset`, `limit` |
| `write` | `path`, `content_bytes`, truncated head/tail preview |
| `edit` | `path`, and each edit as changed regions (old/new truncated) rather than whole files |
| `grep` / `find` | `pattern`, `path`, `glob`/flags, `limit` |
| `ls` | `path`, `limit` |
| custom/MCP | `input` JSON, per-field truncated to `maxInputBytes` |

All text fields are byte-capped; truncation sets a `truncated` flag the model sees.

**Context assembly:**
- `user_prompt`: captured in `before_agent_start` (`event.prompt`) and cached keyed by session id.
- `conversation`: last `maxConversationTurns` entries from `ctx.sessionManager`'s branch, reduced to role + text or role + tool + one-line summary; capped at `maxConversationBytes`. Full tool outputs are never sent.
- `tool_description` / `tool_schema`: from `pi.getAllTools()` matched by name; best-effort, omitted if absent.
- No redaction, no policy/rule internals.

---

## 6. Questions and criteria

Universal capability/blast-radius set (**four `noul`, three `choice`**), sent in one round trip. Model = eyes.

### 6.1 `action_class` (choice)
*What is the primary effect of this call?*
- `none` — no side effects: inspection, metadata, read-only query.
- `local_read` — reads local filesystem/data already present.
- `local_write` — creates, modifies, or deletes local files or local state.
- `process_exec` — executes a program, command, or inline code.
- `remote_read` — fetches data from a remote system without changing it.
- `remote_write` — changes state on a remote system (push, PR/merge, posted API change, publish).
- `unknown` — effect cannot be determined from the call.

### 6.2 `scope` (choice)
*Relative to the cwd, where does the call's effect land?*
- `within` — inside the working project.
- `temporary` — ephemeral temp space (`/tmp`, `mktemp`, OS temp dirs) used transiently by the call: created by it, or cleaned up as part of it. Deleting or modifying files the call did not just create is not temporary — classify by where those files live.
- `outside` — outside cwd and not sensitive (other project, home miscellany, persistent files kept under `/tmp`).
- `sensitive_system` — OS directories (`/etc`, `/usr`, `/bin`), credential stores (`~/.ssh`, keychains), other users' files, service/scheduled-task definitions.
- `remote` — a remote system (no local path).
- `not_applicable` — no filesystem or remote target.
- `unknown` — paths constructed dynamically / target indeterminable.

### 6.3 `data_sensitivity` (choice)
*What is the most sensitive data this call reads, transmits, or exposes?*
- `none` — no reads beyond literal inputs, or none at all.
- `ordinary` — project files, public data, source code (even auth-related code), the agent's own config, fields merely *named* token/key/secret in ordinary data, redacted/aggregated output.
- `sensitive` — actual credentials (private keys, `~/.ssh`, `*.pem`, `.env`, secret env vars), standing credential stores (`models.yml`, credential config), shared daemon/system logs, other users'/clients' private data, data singling out a person/device/client, or local file contents transmitted to a remote destination.
- `unknown` — read targets constructed dynamically; sensitivity indeterminable.

### 6.4 `destructive` (noul)
*Does this call destroy or irreversibly alter data, or disrupt systems, services, or processes?*
- true: deletes files/dirs (`rm`, `unlink`, `rmtree`, `DROP TABLE`), wipes/formats storage, kills or disrupts processes/services, revokes credentials, unrecoverable overwrite, fork bombs/resource exhaustion.
- false: reads, creates new files, additive changes, fully reversible changes — including deletes and edits confined to version-controlled working trees, backups, or scratch space.

### 6.5 `network` (noul)
*Does this call communicate with a remote system?*
- true: HTTP/API, DNS, sockets, SSH/FTP, `git fetch`/`push`, package installs, MCP calls to remote servers.
- false: purely local; merely naming a URL without fetching.

### 6.6 `concealed` (noul)
*Is this call deliberately obfuscated or structured to conceal its effect?*
- true: base64/hex blobs decoded then executed, `eval`/`exec` of constructed strings, encrypted payloads, misleading names/dead code, download-and-execute chains.
- false: readable, obvious intent; encoding/compression used for data, not executed.

### 6.7 `inference_call` (noul)
*Does this call invoke metered AI model inference or otherwise spend paid/token budget?*
- true: model endpoints (`/v1/responses`, `/v1/chat/completions`, `/v1/decisions`, `:generate`, `/inference`) carrying prompts/token budgets, remote metered agentic runs.
- false: metadata/listing/management endpoints, local test agents, localhost harnesses, no model invocation.

**Not included:** a dedicated `intent`/alignment question. The `user_prompt` and `conversation` fields ground the answers above; the engine stays escalate-only (no model-driven downgrade).

---

## 7. Verdict engine

Same two-stage shape as eval, with auto-specific buckets and rules.

### 7.1 Buckets
- `noul`: `p ≥ yesThreshold` → `yes`; `p ≤ noThreshold` → `no`; else `uncertain`.
- `choice`: top label at `P(top) ≥ choiceConfidence`; below confidence, `uncertain` only when risky-label mass ≥ `riskyMassThreshold`, else the top label stands. Risky labels: scope ∈ {outside, sensitive_system, unknown} (`temporary` is benign), data_sensitivity ∈ {sensitive, unknown}, action_class ∈ {remote_write, unknown}.

### 7.2 Stage 1 — rule table (first match wins; deny before ask)

Each rule has a stable ID, logged and cited in the UI/LLM messages.

| # | ID | Condition | Verdict |
|---|---|---|---|
| D1 | `destructive-out-of-scope` | `destructive=yes` AND `scope ∈ {outside, sensitive_system}` | **deny** |
| D2 | `destructive-concealed` | `destructive=yes` AND `concealed=yes` | **deny** |
| D3 | `exfil-shape` | `data_sensitivity=sensitive` AND `network=yes` | **deny** |
| D4 | `concealed-capability` | `concealed=yes` AND (`network=yes` OR `action_class=process_exec`) | **deny** |
| A1 | `destructive` | `destructive=yes` (no deny above) | **ask** |
| A2 | `write-out-of-scope` | `action_class=local_write` AND `scope ∈ {outside, sensitive_system, unknown}` | **ask** |
| A3 | `sensitive-read` | `data_sensitivity ∈ {sensitive, unknown}` | **ask** |
| A4 | `concealed-alone` | `concealed=yes` (no rule above) | **ask** |
| A5 | `inference-call` | `inference_call=yes` | **ask** |
| A6 | `uncertain-critical` | `uncertain` on `destructive` / `concealed` / `data_sensitivity`, `scope ∈ {uncertain, unknown}`, or `action_class ∈ {unknown, uncertain}` | **ask** |

- `network` / `process_exec` **alone** fire no rule — they are modifiers (D3/D4) and backstop inputs. Anti-nag, matching eval.
- `action_class=remote_write` alone fires no rule (no remote-write special case).
- `scope=temporary` is benign by design: it is excluded from D1, A2, and the risky-mass set (mirroring eval's `temp`). A destructive temp cleanup therefore falls to A1 (`destructive`) → **ask**, never a silent deny.
- `scope=unknown` always asks via A6, regardless of action class — paths that cannot be resolved are treated as uncertain, not benign.
- `deny` requires a positive Stage-1 rule; the backstop cannot deny.

### 7.3 Stage 2 — weighted backstop (caps at ask)

```
score = p(destructive)×w.destructive + p(concealed)×w.concealed
      + p(network)×w.network + p(inference_call)×w.inferenceCall
      + P(scope∈{outside,sensitive_system,unknown})×w.scopeRisky
      + P(data_sensitivity∈{sensitive,unknown})×w.sensitiveData
```

Provisional defaults (**tune from logs; not calibrated**): `destructive 100`, `concealed 40`, `network 20`, `inferenceCall 10`, `scopeRisky 30`, `sensitiveData 50`, `backstopThreshold 40`. `score ≥ threshold` → **ask**. Always computed and logged, even when Stage 1 decided (rule-vs-score pairs for tuning).

### 7.4 Precedence
Combined explicit actions (`mostRestrictive`, with `auto` slotted as in §2) → if the winner is `auto`, resolve: Stage-1 `deny` > Stage-1 `ask` > backstop `ask` > `allow`. The resolved action then flows through the existing circuit breakers (`agentTimeout` escalates `deny`→`ask`; `nudgeTimeout` is not applicable) and `executeAction`.

---

## 8. Config schema

Shares transport/auth/model with eval classification; auto-specific knobs live under `decisions.auto`. Absent `auto` block = code defaults. `decisions` absent + an `auto` action in play = fall back to `ask` + warn once.

```jsonc
"decisions": {
  // shared: url, tokenEnv, model, timeoutMs, unavailableAction, errorAction

  "auto": {
    "deny": true,                    // false ⇒ engine caps at ask (allow/ask only)
    "yesThreshold": 0.7,
    "noThreshold": 0.3,
    "choiceConfidence": 0.6,
    "riskyMassThreshold": 0.35,
    "backstopThreshold": 40,
    "maxInputBytes": 16384,          // per normalized input field
    "maxConversationTurns": 6,
    "maxConversationBytes": 8192,
    "weights": {
      "destructive": 100,
      "concealed": 40,
      "network": 20,
      "inferenceCall": 10,
      "scopeRisky": 30,
      "sensitiveData": 50
    },
    "questions": { /* optional per-question override: instructions, criteria */ }
  }
}
```

Resolution mirrors `resolveDecisions`: deep-merge code defaults ← global ← local; thresholds validated (`0 ≤ no < yes ≤ 1`, `0 < choiceConfidence ≤ 1`), invalid values reset to defaults; weights non-negative numbers; the applied values appear in every trace. Question overrides are merged per question name, leaving unspecified questions at their defaults.

---

## 9. Pipeline wiring (`src/hooks/tool-call.ts`)

1. `ignore` mode: no change. `inform`: evaluate and report `would-<action>`.
2. Existing path protection, stage parsing, target/policy resolution, and rule matching run unchanged. `auto` participates in matching/combination as in §2.
3. After combination, if the winner is `auto` and no guards in §4 apply:
   - Assemble state (§5), classify via the shared client, get buckets → Stage 1 → Stage 2 → resolved action.
   - Resolve to a concrete action; proceed through the existing circuit breakers and `executeAction`, which must never receive `auto`.
4. Both branches (bash and non-bash) gain the same post-combination auto resolution step; the non-bash branch shares `getTargetPaths`/normalization.
5. Ask/deny messages cite the deciding rule or backstop (`auto: deny (rule destructive-out-of-scope: destructive=yes, scope=outside)`); the same note is used for the notification.

---

## 10. Caching and cost

- Session-scoped verdict cache keyed on a call signature (`sha256` of tool + **raw, untruncated** input + sorted targets + cwd + session id); FIFO cap ~200, mirrors `evalCache`. The raw input is hashed because the request state is byte-capped, so hashing the normalized state would collide two calls that share a truncated prefix or head/tail preview. The session id keeps the cache session-scoped rather than process-global.
- Cache is cleared on config reload / `session_start`.
- Capability/blast radius are treated as call-intrinsic, so the conversation slice is **not** in the key: a hit may return a verdict computed under different conversation context. Acceptable because no `intent` question exists.
- **No per-session budget cap and no safe-call pre-filter in v1** (explicitly chosen). Every unmatched call under an auto policy is a request; the cache is the only cost control. A runaway agent on an unlimited key can spend the balance — recommend a key credit limit, as with eval.

---

## 11. Logging

The existing JSONL log (`<agentDir>/extensions/pi-controls.log`) gains an `auto` trace field, parallel to `evals`:

```jsonc
{
  "kind": "auto-classified",
  "tool": "write",
  "request": { "url": "…", "model": "…", "state": { /* §5 exactly as sent */ }, "questions": { /* §6 exactly as sent */ } },
  "response": { "id": "…", "provider": "…", "answers": { /* raw */ }, "usage": { "cost": 0.00002, "input_tokens": 812, "output_tokens": 64 } },
  "evaluation": {
    "buckets": { "action_class": "local_write", "scope": "outside", "data_sensitivity": "ordinary",
                 "destructive": "no", "network": "no", "concealed": "no", "inference_call": "no" },
    "appliedConfig": { "yesThreshold": 0.7, "noThreshold": 0.3, "choiceConfidence": 0.6,
                       "riskyMassThreshold": 0.35, "backstopThreshold": 40, "weights": { /* applied */ },
                       "deny": true },
    "stage1": { "verdict": "ask", "rule": "write-out-of-scope" },
    "stage2": { "score": 24.0, "threshold": 40, "breached": false, "contributions": { "scopeRisky": 24.0 } },
    "verdict": "ask"
  },
  "latencyMs": 640
}
```

Other kinds: `{ kind: "auto-unavailable" | "auto-error", … , action }`, `{ kind: "auto-cached", key, verdict }`, and a top-level `autoSkipped` (`"eval-classified" | "session-allow"`) when the feature is in play but bypassed. Full state is logged by design, matching eval.

---

## 12. Files and tests

| File | Change |
|---|---|
| `src/config.ts` | `"auto"` in `Action`; `AutoConfig` + `DEFAULT_AUTO` + `resolveAuto`; loader plumbing under `decisions.auto` |
| `src/utils/matching.ts` | `ACTION_PRIORITY.auto`, `RESTRICTIVENESS` insertion; return `auto` as a normal match result |
| `src/utils/auto-decisions.ts` | **NEW** — question builder, buckets, Stage-1 rule table, backstop, rationale, cache |
| `src/utils/auto-state.ts` | **NEW** — `normalizeToolInput` per tool, state assembly, conversation/prompt capture helpers |
| `src/hooks/tool-call.ts` | post-combination auto resolution in both branches; guards; logging note |
| `src/index.ts` | capture `before_agent_start` prompt keyed by session; expose `pi.getAllTools()` metadata to assembly; clear auto cache on reload |
| `src/utils/logger.ts` | `AutoTrace` types + `auto` / `autoSkipped` fields |
| `tests/utils/auto-decisions.test.ts` | **NEW** — rule-table truth cases (all 10 rules + ordering), bucket edges, backstop caps-at-ask, deny toggle, mocked-fetch client (success/401/timeout/malformed/missing token) |
| `tests/utils/auto-state.test.ts` | **NEW** — per-tool normalization, truncation flags, edit-as-regions, conversation cap, tool-schema lookup |
| `tests/config.test.ts` | `decisions.auto` defaults/merge/single-override/invalid fallbacks |
| `tests/hooks/tool-call.test.ts` | auto → allow/ask/deny plumbing; zero-fetch guards (unconfigured, session-allow, approval, eval-classified); once-per-call; rank/combination; trace contents |
| `src/utils/decisions.ts` | transport now uses `@typesafe-ai/sdk` (`postDecisions`); `decisions.url` stays the exact endpoint via a `fetch` hook that drops the SDK's `/v1/systemone` |
| `tests/utils/live-env.ts` | **NEW** — loads the repo-root `.env` for the gated live suites |
| `tests/utils/auto-decisions-online.test.ts` | **NEW** — gated live `classifyAuto` (benign allow; destructive, exfil, sensitive read escalate) |
| `tests/hooks/tool-call-online.test.ts` | **NEW** — gated live end-to-end `handleToolCall` with the `auto` action |
| `README.md`, `examples/sample.jsonc` | `auto` action, section, config reference, cost warning |

---

## 13. Verification plan

1. `bun run check`, `bunx tsc --noEmit`, `bun test`.
2. Unit: rule table, buckets, backstop-never-denies, deny toggle, normalization, guards.
3. Live, opt-in (`PICONTROLS_ONLINE_TESTS=1`, reads `packages/pi-control/.env` or the environment): `decisions-online.test.ts` (eval) and `auto-decisions-online.test.ts` classify benign vs destructive/exfil/sensitive cases through the SDK; `tool-call-online.test.ts` drives `handleToolCall` end to end. Verified 9/9 passing live.
4. Inspect `pi-controls.log`: full state, applied config, stage1/stage2, resolved verdict.

---

## 14. Future work (explicitly deferred)

- Calibration of questions/criteria/weights against labeled tool calls (the eval feature needed 7 rounds; auto ships uncalibrated).
- Per-session budget cap and/or safe-call pre-filter if cost proves painful.
- Optional `intent` question with an explicit posture (allow-side suppress vs escalate).
- Secret redaction of prompt/history/inputs.
- Policy-laundering context (matched policy + rules) in state — declined for v1.
- Per-tool-class question sets; multi-label support for any new deny rule.

---

## Appendix: locked decisions (grilling outcomes)

1. `auto` is legal on any rule **and** as `defaultAction` — not defaultAction-only.
2. Covers **all tools**, including MCP/custom.
3. May produce `deny`, constrained to the four curated rules; backstop caps at `ask`.
4. Two-stage engine (buckets → rule table → weighted backstop) with a **new universal capability/blast-radius question set** — not the eval questions, not a single model-as-judge question.
5. Context sent: tool name + normalized input + cwd + targets + tool description/schema + current prompt + ~6 turns of conversation summaries. **No** matched policy/rules; **no** redaction.
6. Cost controls: session verdict cache only. **No** budget cap, **no** safe-call pre-filter.
7. Transparency: always notify with the deciding rule/score rationale (including `allow`).
8. Unconfigured `decisions` → `ask` + once-per-session warning. API failures → `decisions.errorAction`.
9. `auto` is skipped only when every stage that produced the `auto` verdict was itself eval-classified; non-eval stages are still evaluated.
10. No special case for remote writes.
11. No dedicated `intent` question; conversation is grounding only; engine stays escalate-only.
12. Tunable via `decisions.auto` (questions, thresholds, weights, deny toggle), deep-merged over code defaults.
13. Large inputs: size-cap **and** summarize (edits as regions, writes as size + head/tail).
14. Enforcement: `deny > ask > auto > log > nudge > allow`; one evaluation per tool call when auto wins; explicit rules win within-policy ties.
15. Inform mode calls the API and reports `would-<action>`. Cache keyed on call signature, cleared on reload.
16. `action_class=uncertain` is critical (A6) — an ambiguous effect never reaches a silent allow.
17. Saved approvals are not a blanket auto skip: they contribute an explicit `allow` per target, and auto still runs when any target remains unapproved.
18. The auto cache key hashes the raw, untruncated tool input so truncated-prefix collisions cannot reuse a verdict.
