# router-shadow

Shadow-mode model-tier router for pi (experiment #1).

Runs model-tier router candidates in the background on every real pi turn and
logs what each router *would* have chosen next to what actually ran — without
changing behavior. The logs feed agreement/latency/cost analysis that decides
whether to move to live routing.

Specs: `docs/REQUIREMENTS.md`, `docs/DESIGN.md` (copied from the experiment
handoff; `docs/HANDOFF.md` has the background and daily-loop commands).

## Layout

- `src/` — extension source:
  - `index.ts` — extension factory: `before_agent_start` handler, command, footer
  - `config.ts` — `routerShadow` settings + env merge (R12)
  - `snapshot.ts` — sync turn capture (R4.3)
  - `origin.ts` — origin, ack, tier mapping (R4.5, R5)
  - `context/` — `entries.ts` (R6.1–6.2), `bounded.ts` (R6.3), `view.ts` (R7.9),
    `utf16.ts`
  - `scrub.ts` — secret scrubbing (R9)
  - `bundle.ts` — exemplar bundle, leakage guard, top-K (R7.5–7.6, R7.10, R8)
  - `route/` — `questions.ts`, `jev.ts`, `embed.ts`, `flash.ts`, `route.ts`
    (pure, reusable for live routing per R16.1)
  - `http.ts` — timeouts, one retry, sanitized errors (R11)
  - `log.ts` — JSONL decision records (R10)
  - `status.ts` — `/router-shadow status` aggregation (R13)
- `docs/` — handoff specs (do not edit; regenerate experiment-side).
- `exemplars.json` — labeled-example bundle shipped with the extension (R8).
- `models.json` — tier → model alias + synonyms.
- `tests/fixtures/` — golden fixtures from the handoff (do not edit).

## Testing

```sh
bun test          # fixture-driven acceptance tests (R14 #1–8) + unit tests
bun run check     # biome + tsc
```

`route()` accepts `timeouts` overrides for fast hang/timeout tests; the
defaults are the R11 budgets (2 s embed, 3 s Jev, 5 s Flash, 8 s turn).

## Configuration

Settings key `routerShadow`, with environment overrides. `apiBase` resolves
as `PLEXUS_API_BASE` → settings `apiBase` → the plexus plugin's own
resolution (`PLEXUS_API_URL`, then `PLEXUS_BASE_URL`, then its saved
`extensions/plexus/config.json`). `apiKey` resolves as settings `apiKey` →
`PLEXUS_API_KEY` → the live plexus provider credential
(`modelRegistry.getApiKeyForProvider("plexus")`, resolved per turn so
OAuth refresh keeps working) — so a working plexus setup needs no extra
config at all. Keys are never logged.

## Turn settling

The `before_agent_start` handler only snapshots; the background run waits
for the turn's persisted ancestry to settle (entry resolution + stability
across polls, 2 s cap) and rebuilds context from the prompt's entry. This
keeps `state_hash` comparable with the experiment rebuild even though pi
persists entries (e.g. the system message) around agent start, and even
though `-p` runs persist the prompt entry after the handler fires.
