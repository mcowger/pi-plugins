# AGENTS.md — pi-control

## What this repo is

A **pi extension and npm package** that intercepts tool calls made by the pi coding agent and enforces action-based policies scoped by filesystem path. Published from `pi-control-v*` tags and installed via `pi install npm:@mcowger/pi-control`.

## Runtime and toolchain

- **Runtime:** Bun (not Node). All scripts assume `bun`.
- **Linter/formatter:** Biome (`biome.json`). Uses **tabs** for indentation.
- **Type checking:** TypeScript strict mode, `moduleResolution: "bundler"`, `types: ["bun-types"]`.
- **Test runner:** `bun:test` (Bun's built-in, not Vitest/Jest). Tests live in `tests/` mirroring `src/`.

## Developer commands

```sh
bun install        # install deps
bun test           # run all 67 tests (5 files, ~600ms)
bun run check      # lint via Biome (exits 1 if issues found)
bun run format     # auto-format with Biome --write
```

`bun run check` currently reports lint errors in `src/utils/logger.ts` (use `export type`) and formatting issues in `examples/sample.jsonc`. These are pre-existing and not regressions.

Run a single test file:
```sh
bun test tests/utils/matching.test.ts
```

## Extension entry point

`package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` — this is how pi discovers and loads the extension. `src/index.ts` is the root.

## Config file discovery

Config is **not** loaded from this repo's directory. The extension reads:
1. Global: `<agentDir>/extensions/pi-controls.jsonc` (or `.json` fallback)
2. Project-local: walks up from CWD looking for `.pi/extensions/pi-controls.jsonc`

`agentDir` is obtained via `getAgentDir()` from `@earendil-works/pi-coding-agent`.

Local wins on deep merge. Config is JSONC (comments allowed). The `$cwd` special key in `locations` resolves to the directory pi was launched from.

## Key architectural facts

- **No explicit rule ordering.** Rules are ranked by specificity (literal chars before first `*`/`?`). Ties go to least-disruptive action: `allow > nudge > ask > deny > log`.
- **Multi-target resolution:** when a bash command touches multiple paths (via redirect targets or path args), the most restrictive action across all of them wins. Order: `deny > ask > log > nudge > allow`.
- **Bash parsing:** `bash-parser` (CJS, imported dynamically) produces a full AST. Fallback is a regex tokenizer if the parser fails. Each pipeline stage (`|`, `&&`, `;`) is evaluated independently.
- **Nudge injection:** `pendingNudges` map in `src/hooks/tool-call.ts` is keyed by `toolCallId`. The `tool_result` handler in `src/index.ts` consumes it to append the message to the tool result content — so the LLM sees it inline.
- **Modes:** `/controls enforce|ignore|inform` — `ignore` skips all evaluation; `inform` evaluates and shows what would happen but never blocks.
- **`$safe-bash` preset:** a rule with `"pattern": "$safe-bash"` expands to ~90 allow rules for read-only commands. See `src/utils/safe-commands.ts` for the full list.

## Source layout

```
src/
  index.ts           # Extension root; registers session_start, tool_call, tool_result, /controls command
  config.ts          # Schema types, JSONC loader, deep merge, $safe-bash expansion
  hooks/
    tool-call.ts     # Main policy enforcement logic; exports pendingNudges map
  utils/
    bash-ast.ts      # bash-parser wrapper + regex fallback; exports parseCommand()
    location.ts      # Path → policy name resolution ($cwd expansion, longest-match)
    matching.ts      # Specificity scoring, rule matching, mostRestrictive()
    path.ts          # ~ expansion and path normalization
    logger.ts        # Append-only JSONL log at <agentDir>/extensions/pi-controls.log
    safe-commands.ts # SAFE_BASH_PATTERNS array (the $safe-bash preset source of truth)
tests/               # Mirrors src/ structure; one test file per utility module
examples/
  sample.jsonc       # Fully annotated reference config
```

## Testing conventions

- Tests import directly from `src/` using `.js` extensions (Bun ESM resolution).
- `tool-call.test.ts` calls `initBashParser()` in `beforeAll` — required before `parseCommand` works.
- Stubs use `mock(() => {})` from `bun:test`, not `jest.fn()`.
- Path resolution tests use hardcoded absolute paths (`/tmp`, `/home/user`) — not relative paths.
