# AGENTS.md — super-agents-pi

## What this package is

An **in-process, user-defined sub-agent extension** for pi. Lets a session delegate tasks to
agents defined as markdown files with YAML frontmatter, each running in a fresh, isolated child
session via `createAgentSession` (never a subprocess). See `PLAN.md` for the full design spec and
`README.md` for user-facing docs.

## Runtime and toolchain

- **Runtime:** Bun. All scripts assume `bun`.
- **Linter/formatter:** Biome — tabs, double quotes, trailing commas, semicolons.
- **Test runner:** `bun:test`. Tests in `tests/` mirror `src/`, importing with explicit `.ts`
  extensions.
- **Commands:** `bun install`, `bun run check` (lint + typecheck), `bun test`.

## Source layout

```
src/
  index.ts             extension entry point; registers session_start/session_shutdown and the
                        four tools (agent, agent_wait, agent_stop, agent_status)
  agents.ts             agent-file discovery/parsing (frontmatter -> AgentDefinition)
  config.ts             superAgents settings.json loading + defaults
  constants.ts           tool names, thinking levels, etc.
  extension-names.ts     matches agent frontmatter extensions:/exclude_extensions: specs against
                          installed extensions (path-derived and package.json-derived names)
  runner.ts               runChild(): builds and runs one child AgentSession
  manager.ts              RunManager: queue, concurrency, background delivery, wait/stop/status
  events.ts               EventEmitter: forwards child session activity as RPC entry_appended
  results.ts              result formatting/truncation for tool output
  semaphore.ts            concurrency limiter used by manager.ts
  truncate.ts             byte-bounded truncation for results/events
  tool-defs.ts             JSON-schema builders + descriptions for the four registered tools
tests/                   mirrors src/, one file per module
```

## Key architectural facts

- **Never spawn `pi` or any subprocess from extension runtime code.** Sub-agents run in-process via
  `createAgentSession`. (Manual smoke testing via the real `pi` CLI binary through Bash is fine and
  distinct from this rule — see below.)
- **Shared `ModelRuntime` for child sessions** (`runner.ts`, matches `PLAN.md` §6.3 step 4):
  ```ts
  const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  ```
  `ModelRegistry.runtime` is a real (unmangled at the JS level, despite the TS `private`) property
  wrapping the canonical `ModelRuntime`. Passing it into `createAgentSession` means **any provider
  registered by a parent-loaded extension is available in the child even when the child agent's
  `extensions:` is `"none"` (the default)** — the child does not need to reload the extension that
  registered the provider, because `registerProvider` mutates the shared runtime object directly.
  This is intentional and verified working (see below), not a gap.
- **`extensions:` frontmatter only controls which extensions *load/bind* in the child** (via
  `DefaultResourceLoader`'s `noExtensions`/`extensionsOverride`), independent of the model-runtime
  sharing above. `extension-names.ts`'s `filterExtensions`/`extensionNames` derive match names two
  ways: a path-derived name (`.../node_modules/[@scope/]<pkg>/...` → `<pkg>`, `.../extensions/<name>/...`
  → `<name>`) and a package.json-derived short name (scope-stripped, lowercased `pkg.name`). Both are
  valid values for an agent's `extensions:`/`exclude_extensions:` list.

## Gotcha: environments where the default model provider is itself an extension

Some environments configure `defaultProvider` in `settings.json` to a provider implemented as a pi
extension rather than a built-in (e.g. a proxy/gateway extension installed via npm). In that setup:

- A child agent with the default `extensions: "none"` **can still call that provider's models**,
  because of the shared-`ModelRuntime` mechanism above. **Verified live**: a child with no
  `extensions:` override successfully called `plexus/muse-spark-1.3` and returned a result, with no
  code changes needed.
- **What actually breaks such a provider is launching the *parent* `pi` process itself with
  `--no-extensions`.** That prevents the provider-registering extension from ever loading, so the
  provider is unknown session-wide — parent and every child fail identically
  (`Error: Unknown provider "<name>"`), before any sub-agent-specific logic even runs.
- **When manually smoke-testing this extension with a real `pi` CLI invocation, never pass
  `--no-extensions`/`-ne` on the outer/parent command.** Achieve isolation instead via a scratch
  `agentDir` (`PI_CODING_AGENT_DIR` env var, honored by the real `getAgentDir()`) and a scratch
  `cwd` with its own `.pi/agents/*.md` — not by disabling the parent's extensions. If the
  environment's default model provider is itself an extension, the scratch `agentDir` must have
  that provider extension installed/configured (or you must pass an explicit `--provider`/`--model`
  that doesn't depend on it) for the parent session to be able to call a model at all.
