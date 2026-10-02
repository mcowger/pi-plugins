# Requirements: `router-shadow` pi extension

Version 2026-10-02. Source experiment: `temp-jev` (see `GOAL.md`, `results/FINDINGS.md`, `results/exp09-latency-cost/`).

## 1. Purpose

Run model-tier routers in **shadow mode** on every real pi turn. Log what each router *would* have chosen next to what actually ran, without changing behavior. The logs feed three analyses:

1. Agreement with Matt's actual model choices.
2. Agreement with blind daily labels, which become a fresh, unanchored test set.
3. Real-world latency, cost and decision volume.

This is experiment #1 of three. The router logic must be reusable, unchanged, inside a `pi.registerVirtualModel()` router (experiment #3).

## 2. Scope

**In scope**
- A pi extension that observes each new user turn and fires router candidates in the background.
- The labeled-example bundle shipped with the extension (`exemplars.json`).
- Append-only JSONL decision logs.
- A `/router-shadow` command for status and on/off.

**Non-goals**
- Changing the model, thinking level, prompt or tools of any turn.
- Routing tool-loop follow-ups, retries or compaction requests.
- Plexus server changes.
- UI beyond an optional footer status and the command.

## 3. Definitions

| Term | Meaning |
|---|---|
| Tier | `economy` → `deepseek-v4.1-flash`, `standard` → `gpt-6-luna`, `high` → `claude-opus-5.5`, `premium` → `gpt-6.1-sol`. Synonyms are in `models.json`. |
| Turn | One submitted prompt that starts an agent run (`before_agent_start`) |
| Candidate | One router configuration evaluated in shadow (section 7) |
| Exemplar | A labeled past request `{tier, preview}` shown to the classifier (`exemplars.json`) |
| Origin | Who wrote the prompt: `human`, `subagent`, `extension`, or `unknown` |
| UTF-16 unit | One JavaScript string `length` unit. A surrogate pair counts as 2. |

## 4. Trigger and turn detection

- **R4.1** Subscribe to `before_agent_start`. Each event is exactly one turn. Don't route from per-request events.
- **R4.2** The handler must return in under 5 ms. All network work is fire-and-forget: start a promise, never `await` it in the handler, and never return a value that modifies the run.
- **R4.3** Snapshot everything needed synchronously inside the handler: prompt, images flag, branch entries, `ctx.model`, thinking level, session file and header.
- **R4.4** Don't route prompts that are empty after trimming.
- **R4.5** Log every other turn. Set `is_ack: true` when the prompt, lower-cased, with trailing `.!?,;:'"` stripped and whitespace collapsed, is at most 40 UTF-16 units **and** matches `^(ok|okay|k|thanks|thank you|thx|yes|yep|yeah|sure|go on|go ahead|continue|please continue|keep going|got it|sounds good|great|do it|cool|nice|perfect)\b`.

## 5. Origin and subagent tagging

Subagent configs stay enabled. The extension tags turns instead of excluding them.

- **R5.1** `is_subagent_session = true` when either:
  - the session header has `parentSession`; or
  - a known subagent extension signals that it created the session (via `pi.events` or session metadata, if available).
- **R5.2** Set `origin` to:
  - `subagent` if `is_subagent_session`, or if the prompt (case-insensitive) starts with or contains:
    - `You are a delegated subagent`
    - `Task: You are`
    - `Message Type: NEW_TASK`
    - a leading `<skill name="…"` (also record `skill_name`)
  - `extension` if the turn came from `pi.sendUserMessage()` by an extension (use the input source if exposed);
  - `human` for interactive-editor or RPC prompt input;
  - `unknown` otherwise.
- **R5.3** `actual.source`:
  - `subagent_config` for subagent sessions;
  - `user_selection` for human sessions whose `ctx.model` was set by `/model`, settings or CLI;
  - `unknown` otherwise.
- **R5.4** Analyses exclude `subagent_config` from agreement-with-actual. Blind labels cover every origin.

## 6. Context snapshot (must match the experiment exactly)

The offline results depend on this format; deviations make shadow results incomparable. The golden fixtures are in `fixtures/entries_to_messages.json` and `fixtures/bounded_state.json`.

- **R6.1** **Entries → messages.** Walk the active branch from the current leaf to the root via `parentId` (`ctx.sessionManager.getBranch()`), then reverse it.
  - **Compaction:** use the *latest* compaction on the path. Stop at its `firstKeptEntryId`, which is included, and insert the compaction's raw `summary` as the **first** message (role `user`). Entries before the boundary are dropped.
  - **`message` entries:** map roles as `user`→user, `assistant`→assistant, `toolResult`→tool, `system`/`developer`→system, and `bashExecution`/`pythonExecution`/`fileMention`/`hookMessage`→user. Any other role maps to user.
    - Text is the `text` parts joined with `\n`.
    - `has_image` is true if any part's type is `image` or `image_url`.
    - Assistant `toolCall` parts become `tool_calls: [{name, arguments}]`. `arguments` is a string: keep it if it's already a string; otherwise use JSON with **sorted keys** and separators `,` and `:` with no spaces.
    - `toolResult` records carry `name = message.toolName`.
    - `api` is `message.api`.
  - **`branch_summary` entries** become a `user` message with the raw `summary`.
  - **`custom_message` entries** become a `system` message with the content text, **except** `customType == "wj-pi-subagents-activity"`, which is dropped.
  - All other entry types are omitted.
- **R6.2** **Current prompt.** The prompt must be the **last** message (role `user`). If the branch at `before_agent_start` doesn't yet contain the prompt's entry, append `{role: "user", text: prompt}`. If the last branch message is already a user message whose text equals the prompt after whitespace collapsing, don't append. For images: set that message's `has_image`. **Don't** add any marker text to the state.
- **R6.3** **Bounded state** (Plexus `buildClassificationContext` parity):
  - Take the last **8** messages.
  - For each in order, **first** check the budget: stop if the running total is already ≥ **6000**. Then scrub the text (section 9) and truncate it to **800** UTF-16 units. If anything was cut, append `…[truncated N]`, where N = UTF-16 units removed. Never split a surrogate pair: if the next code point doesn't fit, stop before it. Add the resulting length, suffix included, to the running total.
    - Under the current limits the budget can't trigger: 7 messages of at most about 820 units total under 6000. Implement it anyway, for parity.
  - **Output message:** `{role, text}`.
    - Add `tool_calls: [{name, arguments}]` only if non-empty. Each `arguments` is scrubbed, then truncated to **200** units with the same suffix rule.
    - Add `name` only when role is `tool` and a name exists.
  - **`structural`:**
    - `message_count`: number of messages *before* the 8-message cut;
    - `has_tools`: `false` and `tool_count`: `0`, as constants for parity with the training data;
    - `has_images`: any message's `has_image`;
    - `api_type`: from the latest assistant message's `api` (`openai-responses`→`responses`, `anthropic-messages`→`messages`, `openai-completions`→`chat`, otherwise `unknown`).
  - Envelope: `{"task": "classify_request", "conversation": [...], "structural": {...}}`.
- **R6.4** Implement this as a pure function, `buildBoundedState(messages) → state`, separate from `entriesToMessages(branch, prompt, images) → messages`. Both must pass the fixtures byte-for-byte after JSON round-trip, comparing objects.

## 7. Router candidates

All enabled candidates run concurrently for every routed turn.

### 7.1 Jev call

- **R7.1** POST `${PLEXUS_API_BASE}/v1/decisions`, without doubling `/v1`. Headers: `Authorization: Bearer ${PLEXUS_API_KEY}` and `Content-Type: application/json`.
- **R7.2** Body: `{"model": "jev-1.13", "state": <state>, "questions": {"tier": <question>}}`.
- **R7.3** Few-shot question (`jev-all`, `jev-k24`). The exact strings are in `fixtures/jev.json`:
  - `type`: `"choice"`
  - `instructions`: `"Choose the model tier the user would want for the work remaining in the latest request. Below are past requests from the same user that resemble this one, each with the tier the user chose. Match the user's preferences; similar requests should get similar tiers.\n"` followed by the exemplar lines joined with `\n`.
  - `criteria`:
    - `economy`: "Fully specified or tightly scoped work: read-only audits, delegated subagent tasks, lookups, routine operations."
    - `standard`: "Ordinary interactive engineering: bounded changes, explanations, everyday debugging."
    - `high`: "Ambiguous work with clear success criteria: subtle debugging, correctness-sensitive integration, iterating on rejected work."
    - `premium`: "Open-ended work: trade-off discussion, comparison, recommendation, design, creativity."
- **R7.4** Zero-shot question (`jev-zeroshot`): the same `criteria`, with `instructions` exactly `"Choose the model tier the user would want for the work remaining in the latest request."`
- **R7.5** Exemplar line: `- [<tier>] <preview>`. Use `preview` from the bundle as-is; it's already scrubbed, collapsed and capped at 240 characters plus `…`.
- **R7.6** **Leakage guard.** Normalize the current prompt: collapse whitespace runs to one space, trim, `toLowerCase()`. Exclude any exemplar whose `prompt_norm_hash` equals sha256(normalized) **or** whose `prompt_prefix_hash` equals sha256(first 200 characters of normalized). Hashes are lower-case hex SHA-256 of the UTF-8 bytes.
- **R7.7** **Parse:**
  - `answers.tier.choice` must be one of the 4 tiers; otherwise record an error.
  - `answers.tier.probabilities` is the per-tier map.
  - `tier_expected = Σ rank(t)·p(t)`, with E=0, S=1, H=2, P=3.
  - Also record `answers.tier.confidence`, `usage.input_tokens` and `usage.cost`.
  - See `fixtures/jev.json` → `expected_parse` and `invalid_response_examples`.

### 7.2 Candidates

| ID | Default | Description |
|---|---|---|
| `jev-all` | **on** | **All** bundle exemplars (113) in bundle order, minus leakage-guard exclusions. No lookup. Lowest latency (~200 ms). Untested variant: offline, 82 exemplars ordered by similarity scored 63.9%. |
| `jev-k24` | **on** | Embedding lookup, then the top **24** exemplars by cosine, highest first. Best offline Jev: 65.1% on the 83, 76.7% on anchored validation. |
| `jev-zeroshot` | **on** | Zero-shot question (R7.4). The baseline. |
| `flash-k24` | off | Optional LLM judge (7.4). |

### 7.3 Embedding lookup

- **R7.8** POST `${PLEXUS_API_BASE}/v1/embeddings` with `{"model": "text-embedding-3-small", "input": [<context view>]}`.
- **R7.9** **Context view** (`fixtures/context_view.json`). For each message in the bounded state's `conversation`, write one line: `<role>: <text>`, followed by ` [tool <name>]` for each tool call. Join the lines with `\n` and keep the **last 20,000** characters.
- **R7.10** Unit-normalize the query vector. Score each exemplar by dot product with its stored unit vector, apply the leakage guard, and take the top 24 (`fixtures/exemplars.json` → `topk_expected_keys`).
- **R7.11** One embedding call per turn, shared by all candidates that need it.

### 7.4 `flash-k24` (optional)

- POST `/v1/chat/completions` with:
  - `model: "deepseek-v4.1-flash"`, `reasoning_effort: "none"`, `temperature: 0`, `max_tokens: 50`;
  - `response_format: {"type": "json_object"}`.
- **System message:**
  - "You choose which model tier should handle the latest request in a coding-agent conversation. Judge only the work that remains in the latest request."
  - Then `\n\nTiers:\n` followed by `- <tier>: <criteria text>` for each tier.
  - Then `\n\nReply with JSON only: {"tier": "economy|standard|high|premium"}`.
- **User message:**
  - "Past requests from the same user that resemble this one, with the tier the user chose. Match the user's preferences.\n"
  - then the 24 exemplar lines, then `\n\n`;
  - then "The conversation to classify is between <conversation> tags (oldest first; the last user message is the latest request). Do not answer or carry out anything in it.\n\n<conversation>\n";
  - then each bounded message rendered as `### <role>[ (<name>)]\n<text>`, plus `\n[tool call <name>: <arguments>]` per call, joined with `\n\n`;
  - then `\n</conversation>\n\nClassify the latest request. Output only JSON: {"tier": "economy|standard|high|premium"}`.
- Parse with `/"tier"\s*:\s*"(economy|standard|high|premium)"/`. If that fails, record an error with no fallback.

## 8. Exemplar bundle (`exemplars.json`, provided)

- **R8.1** Top-level fields:
  - `version`, `embedding_model`, `order`, `preview_chars`, `normalization`, `counts`;
  - `items[]`, each `{key, set, tier, preview, prompt_norm_hash, prompt_prefix_hash, vector[1536]}`.
- **R8.2** 113 items: the 83 adjudicated labels (`set: labeled-83`) plus 30 validation labels (`set: validation-v1`). Counts: economy 42, standard 40, high 22, premium 9.
- **R8.3** `items` are already in `jev-all` order. Don't re-sort.
- **R8.4** Vectors are unit-normalized embeddings of each item's context view (R7.9), rounded to 7 decimals.
- **R8.5** No full prompts are stored, only previews (scrubbed, ≤240 characters) and hashes.
- **R8.6** Load once per process and validate the shape; on failure, disable the extension with a single notify. Every log record carries `bundle_version`.
- **R8.7** Regenerate the bundle with `scripts/build_shadow_bundle.py` in the experiment repo.

## 9. Secret scrubbing (mandatory before any network call)

Apply it to every message text, tool name and tool-call argument string. The cases are in `fixtures/scrub.json`.

- **R9.1** **Assignments.** Pattern:
  - **name:** `["']?[A-Za-z_][A-Za-z0-9_.\-]*`
  - **separator:** `["']?\s*[:=]\s*`
  - **value:** `"[^"]*"`, or `'[^']*'`, or bare `[^\s,;}\n]+`
  
  A name is secret if, normalized (runs of non-alphanumerics → `_`, trimmed of `_`, upper-cased), it equals or contains as a `_`-separated segment any of: `API_KEY APIKEY ACCESS_TOKEN REFRESH_TOKEN AUTH_TOKEN ID_TOKEN CLIENT_SECRET CLIENTSECRET SECRET_KEY SECRETKEY SECRET TOKEN PASSWORD PASSWD PWD`.
  - Replace a secret's value with `[REDACTED]`, keeping any quotes.
  - **If the name isn't secret, resume scanning at the start of its value**, not after it. Otherwise `credentials-2: dns_cloudflare_api_token=cfut_…` leaks.
- **R9.2** `\bBearer\s+[A-Za-z0-9._\-]+` (case-insensitive) becomes `Bearer [REDACTED]`.
- **R9.3** Known token prefixes (case-insensitive, word boundary, followed by `[A-Za-z0-9_\-]+`) become `[REDACTED]`: `sk- ghp_ gho_ ghs_ GOCSPX- github_pat_ cfut_ glpat- xoxa- xoxb- xoxp- xoxr- AKIA sk_live_ rk_live_`.
- **R9.4** Order: assignments, then bearer, then prefixes.

## 10. Logging

- **R10.1** Write one JSON line per turn to `~/.pi/agent/router-shadow/decisions-YYYY-MM-DD.jsonl` (UTC date), after all candidates settle or time out.
  - Make it a single append (`O_APPEND`). Concurrent sessions must not interleave lines.
- **R10.2** Schema (`schema: 1`):
```json
{
  "schema": 1, "ts": "ISO-8601 UTC",
  "session_file": "abs path", "session_id": "uuid", "entry_id": "user message entry id or null",
  "parent_session": "abs path or null", "cwd": "abs path",
  "origin": "human|subagent|extension|unknown", "skill_name": null,
  "is_subagent_session": false, "is_ack": false,
  "actual": {"provider": "plexus", "model": "claude-opus-5.5", "thinking": "high", "tier": "high", "source": "user_selection|subagent_config|unknown"},
  "prompt_chars": 412, "prompt_norm_hash": "hex", "state_hash": "hex sha256 of canonical state JSON",
  "structural": {"message_count": 57, "has_images": false, "api_type": "responses"},
  "bundle_version": "2026-10-02",
  "embedding": {"latency_ms": 288, "error": null},
  "candidates": {
    "jev-all": {"tier": "standard", "probs": {"economy": 0.1, "standard": 0.7, "high": 0.15, "premium": 0.05},
                "tier_expected": 1.15, "confidence": 0.62, "latency_ms": 201, "input_tokens": 5400,
                "cost": 0.000227, "excluded_exemplars": 0, "error": null},
    "jev-k24": {"...": "...", "exemplars": ["contexts:12", "original:7"]},
    "jev-zeroshot": {"...": "..."}
  },
  "skipped": null,
  "handler_ms": 2
}
```
- **R10.3** `entry_id` is the session entry ID of the user message for this turn. If it isn't known at `before_agent_start`, resolve it on `message_end` for the first user message of the run, before writing. **The blind-sample tooling needs `session_file` + `entry_id` to rebuild the turn.**
- **R10.4** `actual.tier` comes from `models.json`, matching the alias or any synonym; otherwise `null`.
- **R10.5** **Never log** prompt or message text, previews, API keys, or request/response bodies. `exemplars` holds keys only.
- **R10.6** Error strings are sanitized: no URL host, no key, at most 200 characters.

## 11. Performance, reliability and limits

- **R11.1** Timeouts:
  - embeddings: 2 s;
  - each Jev call: 3 s;
  - Flash: 5 s;
  - whole turn: 8 s.
  
  On timeout, record `error: "timeout"`.
- **R11.2** At most 2 turns in flight per process. Skip extra turns with `skipped: "backpressure"`.
- **R11.3** One retry, only for HTTP 429/502/503/504 or network errors, after 300 ms and within the timeout.
- **R11.4** Background work must not keep pi alive: use `unref` timers and an `AbortController`. On `session_shutdown`, abort and write a partial record with `error: "aborted"`.
- **R11.5** Any exception is caught and logged to `errors-YYYY-MM-DD.jsonl`. Nothing surfaces in the transcript.
- **R11.6** Expected cost per turn:
  - `jev-all` ≈ $0.00023;
  - `jev-k24` ≈ $0.00011, embedding included;
  - `jev-zeroshot` ≈ $0.00005.
  
  Jev bills $0.042/M input tokens, and Plexus now records it.

## 12. Configuration

Read from the pi settings key `routerShadow`, with environment overrides.

| Setting | Env | Default |
|---|---|---|
| `enabled` | `ROUTER_SHADOW_ENABLED` | `true` |
| `candidates` | `ROUTER_SHADOW_CANDIDATES` | `jev-all,jev-k24,jev-zeroshot` |
| `apiBase` | `PLEXUS_API_BASE` | required |
| `apiKey` | `PLEXUS_API_KEY` | required, never logged |
| `jevModel` | | `jev-1.13` |
| `k` | | `24` |
| `bundlePath` | | `<extension dir>/exemplars.json` |
| `modelsPath` | | `<extension dir>/models.json` |
| `logDir` | | `~/.pi/agent/router-shadow` |
| `sampleRate` | | `1.0` |
| `routeSubagents` | | `true` |
| `footer` | | `false` |

If `apiBase` or `apiKey` is missing, disable the extension with one notify.

## 13. Command and status

- `/router-shadow status`: today's routed, skipped and error counts; median and 90th-percentile latency per candidate; prediction mix per candidate; agreement with actual for `origin=human` and `actual.source=user_selection`.
- `/router-shadow on|off`: toggles for the session. Persist it with `pi.appendEntry`.
- Optional footer, e.g. `shadow: standard`, showing the last `jev-all` prediction.

## 14. Acceptance tests

1. `entriesToMessages` and `buildBoundedState` reproduce `fixtures/entries_to_messages.json` and `fixtures/bounded_state.json`.
2. The scrubber reproduces every case in `fixtures/scrub.json`.
3. The context view reproduces `fixtures/context_view.json`.
4. Exemplar lines match `fixtures/exemplars.json` → `lines_first_3`. Top-k for `topk_query_key` (query = that item's vector, with the leakage guard triggered by the item's own hashes) equals `topk_expected_keys`, order included.
5. Jev request bodies equal `fixtures/jev.json` → `jev_all_request` and `jev_zeroshot_request` for the given state. Parsing gives `expected_parse`. Each `invalid_response_examples` entry produces an error.
6. With the network mocked to hang, the handler returns in under 5 ms; the turn proceeds; the record is written with `timeout`.
7. Origin tagging: a `parentSession` header gives `subagent`; the `Task: You are a delegated subagent` prefix gives `subagent`; editor input gives `human`.
8. With a sentinel string in the prompt, no log line contains the sentinel.
9. **Live parity:** for a real session turn logged by the extension, `scripts/shadow_report.py sample` in the experiment repo rebuilds a state whose hash equals the logged `state_hash`. The experiment-side rebuild already matches 40/40 recorded contexts.

## 15. Analysis (experiment repo, `scripts/shadow_report.py`)

- **Daily:**
  - `python3 scripts/shadow_report.py sample --date YYYY-MM-DD` writes 5 blind items (at least 3 human) to `data/human/shadow-<date>/`. Claude presents them in the chat tap format with no predictions shown, and the labels go to `labels.jsonl`.
  - `python3 scripts/shadow_report.py report` prints the per-candidate table: errors, latency, cost, prediction mix, agreement with actual, agreement with blind labels, and blind under-routing on high/premium.
- **Duration:** 14 days, or at least 1,000 routed human turns.
- **Go/no-go for live routing:**
  - blind-label agreement of at least 65%, with n ≥ 60;
  - blind high/premium turns routed to economy/standard in at most 10% of cases;
  - `jev-all` latency at the 90th percentile of at most 400 ms;
  - error and timeout rate of at most 2%.

## 16. Path to live routing (design constraint only)

- **R16.1** Candidate logic lives in a pure module: `route(state, prompt, bundle, config, http) → {tier, probs, …}`, with no dependency on the shadow handler.
- **R16.2** Live mode registers `router/auto` with `pi.registerVirtualModel()`:
  - when `request.reason === "user"`, call `route()` and map the tier to its model;
  - otherwise, return `request.failed ?? request.previous` (sticky tool loops and retries);
  - on error or timeout, use `standard`.
- **R16.3** Subagent configs can later point at `router/auto`.
