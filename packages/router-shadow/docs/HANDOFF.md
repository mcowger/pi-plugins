# router-shadow handoff

Everything needed to build the `router-shadow` pi extension (experiment #1, shadow routing) in another repo. Copy this whole folder.

| File | What it is |
|---|---|
| `REQUIREMENTS.md` | What to build. Numbered requirements (R…), acceptance tests, analysis plan, go/no-go criteria. |
| `DESIGN.md` | How to build it: module layout, TypeScript types, turn flow, HTTP and scrubbing details, testing, rollout. |
| `exemplars.json` | 113 labeled examples, already in `jev-all` order: scrubbed 240-character previews, tiers, prompt hashes, unit 1536-d context embeddings. About 1.8 MB. |
| `models.json` | Tier → model alias, plus synonyms, for mapping `ctx.model` to a tier. |
| `fixtures/scrub.json` | Secret-scrubber cases (input → expected). |
| `fixtures/entries_to_messages.json` | Synthetic pi session entries → expected messages and bounded state, including compaction, branch summary, custom messages, tool calls and an image. |
| `fixtures/bounded_state.json` | Message lists → expected bounded state: 800-unit truncation, surrogate boundary, 8-message cap, tool-arg truncation, `name` handling, `api_type`, scrubbing, images. |
| `fixtures/context_view.json` | Bounded state → expected embedding input text. |
| `fixtures/exemplars.json` | Exemplar line format, preview cases, and a top-24 selection with the leakage guard. |
| `fixtures/jev.json` | Exact Jev request bodies (`jev-all`, `jev-zeroshot`) for a fixture state, an example response, the expected parse, and invalid responses. |

## Where these numbers come from

All from the `temp-jev` experiment:
- Jev with 24 retrieved examples: 65.1% exact agreement on 83 labels, scored without fitting anything on those labels. Matt's own self-agreement is about 71%.
- 76.7% on 30 newer labels. Those labels started from Claude's pre-labels, so the figure is optimistic.
- About 200–460 ms added latency and about $0.0001–0.0002 per turn.

## Regenerating

These files are produced by the experiment repo and should not be edited by hand:

```sh
python3 scripts/build_shadow_bundle.py --allow-http      # rebuilds this folder (calls the Plexus embeddings endpoint)
```

## Daily analysis loop (experiment repo)

```sh
python3 scripts/shadow_report.py sample --date 2026-10-03   # 5 blind items -> data/human/shadow-2026-10-03/
python3 scripts/shadow_report.py report                      # per-candidate metrics, including vs blind labels
```
