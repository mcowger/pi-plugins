# `decisions`: the `auto` action and eval classification

The optional top-level `decisions` block turns on two model-backed features. Both use the same endpoint, token, and model:

- **`auto` action**: any call whose winning action is `auto` is sent to the Decisions API and becomes allow/ask/deny.
- **Eval classification**: inline code in bash (`python -c`, `node -e`, `bun -e`, `deno eval`, `tsx -e`, `bash -c`, heredocs fed to an interpreter) is classified. It can raise the verdict but never lower it.

Without a `decisions` block, eval classification is off and `auto` behaves as `ask` (with a one-time warning).

## Minimal block

```jsonc
{
  "decisions": {
    "url": "https://openrouter.ai/api/alpha/decisions",   // default
    "tokenEnv": "OPENROUTER_API_KEY",                      // env var NAME, never the token
    "model": "typesafe/jev-1.13"                          // default
  }
}
```

**Tell the user before enabling this:**
- **Data egress.** Auto sends the tool name, the normalized input (command, write preview, edit regions), the cwd, targets, the tool description and schema, the current user prompt, and about 6 recent conversation turns. Nothing is redacted, and it's all logged unredacted to `pi-controls.log`. Use a trusted endpoint, or keep `auto` out of sensitive repos.
- **Cost.** One request per call that reaches `auto` or contains an inline eval. Repeats are cached per session. Put a credit limit on the key.

## Top-level `decisions` fields

| Field | Default | Meaning |
|---|---|---|
| `url` | OpenRouter decisions URL | Endpoint |
| `tokenEnv` | `OPENROUTER_API_KEY` | Env var holding the bearer token |
| `model` | `typesafe/jev-1.13` | Model |
| `timeoutMs` | `15000` | Per-request timeout |
| `errorAction` | `"ask"` | Verdict on API/auth/timeout/malformed errors (`allow`/`ask`/`deny`) |
| `unavailableAction` | `"ask"` | Eval-shaped command whose source can't be recovered (`python -c "$CODE"`, `curl … \| python`) |
| `maxSourceBytes` | `32768` | Eval source truncation |
| `yesThreshold` / `noThreshold` / `choiceConfidence` / `riskyMassThreshold` / `backstopThreshold` / `weights` | — | Tuning for **eval classification** only |
| `auto` | — | Tuning for the **auto action** (below) |

## `decisions.auto` fields

| Field | Default | Meaning |
|---|---|---|
| `deny` | `true` | `false` caps every auto verdict (including `errorAction: "deny"`) at `ask` |
| `yesThreshold` | `0.7` | Boolean probability ≥ this counts as yes |
| `noThreshold` | `0.3` | ≤ this counts as no; anything between is uncertain |
| `choiceConfidence` | `0.6` | Top-label probability needed to accept a choice answer |
| `riskyMassThreshold` | `0.35` | Below that confidence, risky-label mass ≥ this counts as uncertain |
| `thresholds` | from globals | Per-question overrides (newer versions — see below) |
| `backstopThreshold` | `40` | Weighted score ≥ this → ask |
| `weights` | destructive 100, concealed 40, network 20, inferenceCall 10, scopeRisky 30, sensitiveData 50 | Backstop weights; override single keys |
| `maxInputBytes` / `maxConversationTurns` / `maxConversationBytes` | 16384 / 6 / 8192 | Context size caps |
| `questions` | — | `{ "<question>": { "instructions"?, "criteria"? } }` wording overrides |

All of these deep-merge, so a project can set one weight or one threshold.

### Per-question thresholds

```jsonc
"decisions": { "auto": { "thresholds": {
  "destructive":      { "yes": 0.6, "no": 0.2 },   // boolean: yes / no
  "network":          { "yes": 0.8 },
  "data_sensitivity": { "confidence": 0.7, "riskyMass": 0.4 }   // choice: confidence / riskyMass
} } }
```

- Boolean questions: `destructive`, `network`, `concealed`, `inference_call`.
- Choice questions: `action_class`, `scope`, `data_sensitivity`.
- Unset entries fall back to the globals. Out-of-range values, `0` for choice values, and a `yes` that isn't above `no` are ignored.
- Lowering `yes` on a question makes it trip more readily (stricter). Raising `confidence` sends more choice answers to "uncertain", which then asks.

## How auto decides

The model answers 7 questions: `action_class`, `scope`, `data_sensitivity` (choice), plus `destructive`, `network`, `concealed`, `inference_call` (boolean). Answers are bucketed with the thresholds above, then:

**Scope comes from paths when possible.** When every path the call touches is known (a file tool's `path`, or a bash command with no `$VAR`/`$(…)`), pi-controls classifies them itself: `within` the cwd, `temporary` (`/tmp`, …), `outside`, or `sensitive_system` (`/etc`, `~/.ssh`, `.env`, `*.pem`, …). The riskiest wins, and that replaces the model's answer. Otherwise the model's scope is used.

**Stage 1 rules — the first match wins; deny rules first:**

| Rule | Condition | Verdict |
|---|---|---|
| `destructive-out-of-scope` | destructive=yes and scope outside/sensitive_system | deny |
| `destructive-concealed` | destructive=yes and concealed=yes | deny |
| `exfil-shape` | data=sensitive, network=yes, and (remote_write, or process_exec + sensitive_system) | deny |
| `concealed-capability` | concealed=yes and (network=yes or process_exec) | deny |
| `destructive` | destructive=yes | ask |
| `write-out-of-scope` | local_write to outside/sensitive_system/unknown | ask |
| `sensitive-read` | data sensitive/unknown | ask |
| `concealed-alone` | concealed=yes | ask |
| `inference-call` | inference_call=yes | ask |
| `uncertain-critical` | any critical dimension uncertain/unknown | ask |

With `deny: false`, the deny rows are skipped.

**Stage 2 backstop** (only when no rule fired): a weighted sum of probabilities. If it reaches `backstopThreshold` the verdict is ask, otherwise allow. It never denies.

## Where auto sits in precedence

- It's an action like any other. Inside a policy it **loses same-specificity ties** to explicit rules (`allow > nudge > ask > deny > log > auto`).
- Across targets and stages it ranks `deny > ask > auto > log > nudge > allow`. So any explicit deny/ask wins, and auto beats a plain allow.
- A call is evaluated by auto **once**, covering all its targets.
- Skipped (no API call) in `ignore` mode, for session-allowed calls, and when every auto-producing stage was already handled by eval classification.

## Reading an auto verdict

Prompts and deny reasons explain themselves (newer versions):

```
auto: rule sensitive-read: data_sensitivity=sensitive (sensitive 0.70, ordinary 0.25); other signals: destructive=no, network=no, concealed=no; scope=outside (from paths); targets: /home/me/.pi/agent/extensions/pi-controls.log (outside)
```

- `rule …:` shows the rule and the signal that drove it, with the model's probabilities.
- `other signals:` lists what the model did *not* find.
- `scope=… (from paths | no paths | model)` shows where scope came from.
- `backstop score 52 ≥ 40 (scopeRisky 30 + …)` means no rule fired and the weighted sum tripped.
- `auto (cached): …` is a repeat of an earlier verdict in this session.

The full request and answers are in the `auto` trace in `pi-controls.log`: `request.state`, `request.questions`, `response.answers`, `evaluation.buckets`, `scopeSource`, `appliedConfig`, `stage1`, and `stage2`.

## Fixing a bad auto verdict

Prefer the most targeted fix:

1. **Add an explicit rule** for the command or tool. It beats `auto` at equal or higher specificity, costs nothing, and is deterministic.
2. **Save an approval** ("Allow for Project" / "Allow Globally" in the prompt). This writes to `approvalRules`.
3. **Adjust one threshold** in `decisions.auto.thresholds` for the dimension that misfired (from the explanation). For example, `data_sensitivity` confidence if ordinary files keep reading as sensitive.
4. **Override one question's criteria** under `decisions.auto.questions` if the model keeps misreading a category.
5. As a last resort, lower `weights` or raise `backstopThreshold`, or set `deny: false` so the model can only ask.
