# super-agents-pi — Implementation Plan

Pi extension that lets the parent model delegate tasks to **user-defined sub-agents** that run
**in-process** (Pi SDK `createAgentSession`), with tool/extension/model restrictions, background
execution, and full event passthrough for RPC clients.

Read this whole document before writing code. Follow the milestones in order. Every milestone ends
with `bun run check` and `bun test` passing inside `packages/super-agents-pi`.

---

## 0. Decisions (fixed — do not re-litigate)

| Topic | Decision |
|---|---|
| Execution | In-process via `createAgentSession`. **Never** spawn `pi` or any subprocess. |
| Start | Single call: create session + send prompt in one tool call. |
| Lifecycle | Pure one-shot. Session is disposed when the run ends. No follow-ups to a finished agent. |
| Foreground / background | Foreground (blocking) by default. `background: true` returns ids immediately; results are pushed to the parent as a message when done. `agent_wait` / `agent_stop` / `agent_status` tools exist. |
| Parallelism | One `agent` call accepts `tasks[]` (1..`maxTasksPerCall`). Tasks in one call run concurrently. |
| Built-in agents | **None.** If no agent files exist, the tool reports that no agents are configured. |
| Discovery | `~/.pi/agent/agents/*.md` (user) and `<cwd>/.pi/agents/*.md` (project). **No project-trust gate.** Project overrides user on the same slug. |
| Naming | Slug = filename without `.md`. Optional `display_name`. Parent may give each task an instance `name`. |
| Advertising | `agent` param is an enum of slugs; tool description lists `slug: description` lines plus short guidance. **No** system-prompt injection. All text in English. |
| Tools default | Frontmatter omits `tools` → `read, grep, find, ls` only. |
| Extensions default | Frontmatter omits `extensions` → **no** extensions loaded in the child. |
| Child context default | Parent's base system prompt + agent body appended. **No** AGENTS.md/context files, **no** skills, **no** parent conversation history. Each overridable per agent. |
| Nesting | **Never.** Children never get the sub-agent tools; this extension is never loaded into a child. |
| Model / thinking | Frontmatter pins; else inherit parent's current model/thinking. Parent LLM may request a per-task model/thinking; it is applied **only** if frontmatter `allow_model_override: true`. Otherwise the call is **accepted**, the request is ignored (agent pin / parent inheritance wins), and the result notes it. |
| Result | Child's final assistant text. Inline up to `maxResultBytes` (64 KiB); if larger, truncated inline and full text written to `$TMPDIR/super-agents-pi/<parentSessionId>/<agentId>.md`, path included. |
| Events for RPC client | Passthrough of child `AgentSessionEvent`s **except streaming `message_update` deltas** (dropped; `message_end` carries the full message), tagged, each truncated to `maxEventBytes` (64 KiB), emitted with `pi.appendEntry("super-agents-event", …)` for **both** foreground and background agents. Foreground additionally sends a small progress `onUpdate` (for the TUI). The client only observes — no client control channel. |
| Limits | Global concurrency (default 8) with FIFO queue. `max_turns` per agent (no default = unlimited): at the limit steer "wrap up", abort after `graceTurns` (3) more turns. |
| Config | `superAgents` key in `~/.pi/agent/settings.json`, overridden key-by-key by `<cwd>/.pi/settings.json`. |
| No TUI | No widgets, overlays, menus, or custom renderers beyond what Pi gives by default. |

---

## 1. Verified SDK facts (Pi 0.85.1, `@earendil-works/*`)

These were checked against `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts`. Use them
exactly; do not invent APIs.

- `createAgentSession(options): Promise<{ session, extensionsResult, modelFallbackMessage? }>`.
  Options used: `cwd`, `agentDir`, `modelRuntime?`, `model`, `thinkingLevel`, `tools?: string[]`,
  `excludeTools?: string[]`, `resourceLoader`, `sessionManager`, `settingsManager`.
- `SessionManager.inMemory(cwd)` — no files on disk.
- `SettingsManager.create(cwd, agentDir)` — reads the real global + project settings (compaction,
  retry, etc. are inherited from the user's config).
- `new DefaultResourceLoader({...})` options used: `cwd`, `agentDir`, `settingsManager`,
  `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`,
  `extensionsOverride(base: LoadExtensionsResult) => LoadExtensionsResult`,
  `skillsOverride(base) => base-shaped`, `systemPromptOverride(base: string|undefined) => string|undefined`,
  `appendSystemPromptOverride(base: string[]) => string[]`. **Must call `await loader.reload()`**
  before passing it to `createAgentSession`.
- `LoadExtensionsResult = { extensions: Extension[]; errors; runtime }`, `Extension.path`,
  `Extension.resolvedPath`, `Extension.tools: Map<string, RegisteredTool>`.
- `AgentSession`: `subscribe(listener) => unsubscribe`, `prompt(text)`, `steer(text)`, `abort()`,
  `dispose()`, `bindExtensions({ onError? })`, `getActiveToolNames()`, `getAllTools()` (items have
  `.name`), `setActiveToolsByName(names)`, `getLastAssistantText()`, `getSessionStats()` →
  `{ toolCalls, tokens: {input, output, cacheRead, cacheWrite, total}, cost, … }`, `messages`,
  `model`, `thinkingLevel`, `setSessionName(name)`.
- `AgentSessionEvent` union (see `agent-session.d.ts`): `agent_start`, `agent_end{messages}`,
  `turn_start`, `turn_end{message, toolResults}`, `message_start{message}`,
  `message_update{message, assistantMessageEvent}`, `message_end{message}`,
  `tool_execution_start{toolCallId, toolName, args}`, `tool_execution_update{…, partialResult}`,
  `tool_execution_end{…, result, isError}`, `agent_settled`, `queue_update`, `compaction_start`,
  `compaction_end`, `auto_retry_start`, `auto_retry_end`, `entry_appended`, `thinking_level_changed`,
  `session_info_changed`, `summarization_*`, `bash_execution_update`.
- `assistantMessageEvent` variants all carry `partial: AssistantMessage` (the whole message so far).
- `ExtensionAPI` (`pi`): `registerTool(def)`, `on(event, handler)`, `appendEntry(customType, data)`,
  `sendMessage({customType, content, display, details}, {triggerTurn?, deliverAs?: "steer"|"followUp"|"nextTurn"})`.
- `ExtensionContext` (`ctx`): `cwd`, `model`, `thinkingLevel`, `modelRegistry` (`.find(provider, id)`),
  `sessionManager.getSessionId()`, `isIdle()`, `signal`, `hasUI`, `ui.notify(msg, level)`.
- `ToolDefinition`: `{ name, label, description, promptSnippet?, parameters, executionMode?,
  execute(toolCallId, params, signal, onUpdate, ctx) }`. `onUpdate({ content, details })` becomes a
  `tool_execution_update` event for RPC clients.
- `ModelRegistry` holds its `ModelRuntime` in a TS-private field named `runtime`. Reuse it (see §6.3).
- `parseFrontmatter(content) => { frontmatter, body }` is exported from
  `@earendil-works/pi-coding-agent` and uses the real `yaml` parser. **Use it** (do not hand-roll YAML).
- `getAgentDir()` is exported from `@earendil-works/pi-coding-agent` (respects `PI_CODING_AGENT_DIR`).
- `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` (from
  `@earendil-works/pi-agent-core`).
- Schema helpers: `import { Type, StringEnum } from "@earendil-works/pi-ai"` (repo convention — do
  **not** add a `typebox` dependency).
- Pi RPC mode forwards every parent session event to stdout, including `entry_appended` (from
  `appendEntry`) and `tool_execution_update` (from `onUpdate`). That is how the client sees our events.

---

## 2. Package scaffold (Milestone 1)

Create exactly these files:

```
packages/super-agents-pi/
  PLAN.md                  (this file)
  README.md
  package.json
  tsconfig.json
  biome.json
  index.ts
  src/
    index.ts               extension entry + wiring
    constants.ts
    types.ts
    config.ts
    agents.ts              discovery + parsing + validation
    extension-names.ts     extension-name matching (ported from pi-subagents-lite, MIT)
    tool-defs.ts           builds tool schemas + descriptions
    semaphore.ts           FIFO concurrency limiter
    truncate.ts            byte-bounded JSON truncation
    events.ts              event envelope + emitter
    results.ts             result formatting + overflow files
    runner.ts              creates one child session and runs it
    manager.ts             registry of runs, queue, background delivery, wait/stop/status
  tests/
    config.test.ts
    agents.test.ts
    extension-names.test.ts
    tool-defs.test.ts
    semaphore.test.ts
    truncate.test.ts
    events.test.ts
    results.test.ts
    runner.test.ts
    manager.test.ts
    index.test.ts
```

### package.json

Copy the shape of `packages/pi-suppress-providers/package.json`, with:

```json
{
  "name": "@mcowger/super-agents-pi",
  "author": "Matt Cowger",
  "version": "0.1.0",
  "description": "In-process, user-defined sub-agents for Pi with tool/extension/model restrictions and full RPC event passthrough",
  "license": "MIT",
  "type": "module",
  "keywords": ["pi-package", "pi", "pi-extension", "subagent", "sub-agent", "agents"],
  "repository": { "type": "git", "url": "https://github.com/mcowger/pi-plugins.git", "directory": "packages/super-agents-pi" },
  "homepage": "https://github.com/mcowger/pi-plugins/tree/main/packages/super-agents-pi#readme",
  "bugs": { "url": "https://github.com/mcowger/pi-plugins/issues" },
  "engines": { "bun": ">=1.0" },
  "files": ["index.ts", "src/", "README.md"],
  "scripts": {
    "check": "bun run lint && bun run typecheck",
    "format": "bunx biome format --write index.ts src tests",
    "format:check": "bunx biome format index.ts src tests",
    "lint": "bunx biome check index.ts src tests",
    "pack:dry-run": "npm pack --dry-run",
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test"
  },
  "peerDependencies": {
    "@earendil-works/pi-agent-core": ">=0.85.1",
    "@earendil-works/pi-ai": ">=0.85.1",
    "@earendil-works/pi-coding-agent": ">=0.85.1"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.1",
    "@earendil-works/pi-agent-core": "0.85.1",
    "@earendil-works/pi-ai": "0.85.1",
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@types/node": "^26.1.1",
    "bun-types": "1.3.14",
    "typescript": "^6.0.3"
  },
  "pi": { "extensions": ["./index.ts"] }
}
```

No runtime `dependencies`. Everything comes from Pi peer deps and Node built-ins.

### tsconfig.json

Copy `packages/pi-suppress-providers/tsconfig.json` and change `include` to
`["index.ts", "src/**/*.ts", "tests/**/*.ts"]`.

### biome.json

Copy `packages/pi-suppress-providers/biome.json` verbatim.

### index.ts

```ts
export { default } from "./src/index.ts";
```

### Root wiring

In the root `package.json`, add `super-agents-pi` to `check`, `test`, `lint`, `format`, and
`format:check`, following the existing pattern (add a `check:super-agents-pi` script too). In the
root `AGENTS.md` "Package layout" list, add:
`- packages/super-agents-pi: in-process user-defined sub-agents extension.`

Publish tag convention (for later): `super-agents-pi-v0.1.0`. Check the root publish workflow under
`.github/workflows/` and, if it has an allowlist of package names, add this package.

**Milestone 1 done when:** `bun install` at root succeeds, and `src/index.ts` exports a default
function `(pi: ExtensionAPI) => void` that does nothing yet; `bun run check` passes.

---

## 3. Constants and types (Milestone 2)

### src/constants.ts

```ts
export const EXTENSION_ID = "super-agents-pi";
export const SETTINGS_KEY = "superAgents";
export const EVENT_ENTRY_TYPE = "super-agents-event";     // appendEntry customType
export const RESULT_MESSAGE_TYPE = "super-agents-result";   // sendMessage customType (background results)
export const EVENT_SCHEMA_VERSION = 1;
export const TOOL_AGENT = "agent";
export const TOOL_WAIT = "agent_wait";
export const TOOL_STOP = "agent_stop";
export const TOOL_STATUS = "agent_status";
export const OWN_TOOL_NAMES = [TOOL_AGENT, TOOL_WAIT, TOOL_STOP, TOOL_STATUS] as const;
export const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TURN_LIMIT_STEER =
  "You have reached your turn limit. Stop using tools and give your final answer now.";
export const CHILD_PROMPT_FOOTER = [
  "You are running as a sub-agent on behalf of another agent.",
  "You cannot ask the caller questions; work with the task as given.",
  "Your final message is returned verbatim to the caller as your result, so make it complete and self-contained.",
].join("\n");
export const BACKGROUND_BATCH_MS = 200;
```

### src/types.ts

Define (and export) these types. Keep them plain data.

```ts
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SuperAgentsConfig {
  maxConcurrent: number;        // default 8
  maxTasksPerCall: number;      // default 8
  graceTurns: number;           // default 3
  maxResultBytes: number;       // default 65536
  maxEventBytes: number;        // default 65536
  events: {
    enabled: boolean;                          // default true
  };
  overflowDir?: string;         // default undefined → os.tmpdir()/super-agents-pi
}

export type ExtensionsSpec = "none" | "all" | string[];
export type SkillsSpec = "none" | "all" | string[];

export interface AgentDefinition {
  slug: string;                 // filename without .md
  displayName: string;          // display_name ?? slug
  description: string;          // required, single line after trimming/collapsing whitespace
  body: string;                 // markdown body (trimmed); may be ""
  tools: string[];              // resolved allowlist (DEFAULT_TOOLS if omitted)
  excludeTools: string[];       // default []
  extensions: ExtensionsSpec;   // default "none"
  excludeExtensions: string[];  // default []; only meaningful with extensions: "all"
  skills: SkillsSpec;           // default "none"
  contextFiles: boolean;        // default false
  systemPromptMode: "append" | "replace"; // default "append"
  model?: string;               // "provider/modelId"
  thinking?: ThinkingLevel;
  allowModelOverride: boolean;  // default false
  maxTurns?: number;            // positive integer; undefined = unlimited
  source: "user" | "project";
  filePath: string;
}

export interface AgentLoadResult {
  agents: AgentDefinition[];    // sorted by slug
  errors: Array<{ filePath: string; message: string }>;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "turn_limited";

export interface TaskInput {
  agent: string;
  prompt: string;
  name?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface RunUsage {
  turns: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

export interface RunRecord {
  id: string;                   // e.g. "a7k2m9qz" (8 chars [a-z0-9]); THE id — no short/long forms
  name: string;                 // instance name, unique among non-finished runs
  slug: string;
  prompt: string;
  background: boolean;
  parentToolCallId: string;
  status: RunStatus;
  model?: string;               // "provider/id" actually used
  thinking?: ThinkingLevel;
  overrideIgnored?: boolean;    // task asked for model/thinking but agent disallows overrides
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  resultText?: string;          // full final text (kept in memory until delivered)
  outputPath?: string;          // overflow file if written
  error?: string;
  usage?: RunUsage;
  delivered: boolean;           // result consumed by agent_wait / foreground return / background push
}
```

**Milestone 2 done when:** files compile.

---

## 4. Config (Milestone 3) — src/config.ts

### API

```ts
export const DEFAULT_CONFIG: SuperAgentsConfig;
export function mergeConfig(...partials: Array<unknown>): SuperAgentsConfig;
export function loadConfig(cwd: string, agentDir: string): { config: SuperAgentsConfig; warnings: string[] };
```

### Behavior

1. `loadConfig` reads `<agentDir>/settings.json` and `<cwd>/.pi/settings.json`. Missing file → skip.
   Invalid JSON → warning `"super-agents-pi: could not parse <path>: <msg>"`, skip. Take
   `json.superAgents` from each (skip if not a plain object).
2. `mergeConfig(defaults-implied, global, project)`: start from `DEFAULT_CONFIG`, then apply each
   partial in order. For each known key, accept the value **only if valid**, otherwise push a warning
   and keep the previous value:
   - `maxConcurrent`, `maxTasksPerCall`: integer ≥ 1.
   - `graceTurns`: integer ≥ 0.
   - `maxResultBytes`, `maxEventBytes`: integer ≥ 1024.
   - `events.enabled`: boolean. Merge `events` key-by-key. Unknown keys under `events`:
     warning, ignored.
   - `overflowDir`: non-empty string.
   - Unknown keys: warning, ignored.
   (Make `mergeConfig` return `{config, warnings}` internally; the exported `mergeConfig` may just
   return the config — your choice, but tests must be able to see warnings.)
3. Defaults: `maxConcurrent 8, maxTasksPerCall 8, graceTurns 3, maxResultBytes 65536,
   maxEventBytes 65536, events {enabled: true}, overflowDir undefined`.

### Tests (tests/config.test.ts)

- Defaults when no files.
- Global overrides default; project overrides global per key; `events` merges per key.
- Invalid values produce warnings and are ignored.
- Invalid JSON file produces a warning and does not throw.
- Use `mkdtemp` temp dirs for `agentDir` and `cwd`.

---

## 5. Agent discovery (Milestone 4) — src/agents.ts

### API

```ts
export function loadAgents(cwd: string, agentDir: string): AgentLoadResult;
export function parseAgentFile(filePath: string, content: string, source: "user"|"project"): AgentDefinition; // throws Error(message) on invalid
```

### Discovery

1. Directories, in order: user `path.join(agentDir, "agents")`, project `path.join(cwd, ".pi", "agents")`.
2. In each, list **direct children only** whose name ends with `.md` (case-sensitive, lowercase
   `.md`). Skip subdirectories and dotfiles. Missing dir → skip silently.
3. Slug = basename without `.md`. If slug fails `SLUG_PATTERN` → error
   `"invalid agent file name '<file>': slug must match ^[a-z0-9][a-z0-9_-]{0,63}$"`, skip.
4. Parse each file with `parseAgentFile`. On throw → push `{filePath, message}` to `errors`, skip.
5. Build a `Map<slug, AgentDefinition>`; project entries **replace** user entries with the same slug
   (whole-file replacement, not field merge).
6. Return agents sorted by slug.

### Frontmatter fields (snake_case in files)

Use `parseFrontmatter` from `@earendil-works/pi-coding-agent`. If `parseFrontmatter` throws (bad
YAML), throw `"invalid YAML frontmatter: <msg>"`. Validate each field; any violation throws with a
message naming the field.

| Field | Type in YAML | Rule | Maps to |
|---|---|---|---|
| `description` | string | **required**, non-empty after trim. Collapse all whitespace runs to single spaces. | `description` |
| `display_name` | string | optional, non-empty | `displayName` (default = slug) |
| `tools` | list of strings | optional. Each non-empty string, trimmed, deduped. `[]` allowed (= no tools). A **non-list** (e.g. `true`, `"read"`) is an error: `"tools must be a list of tool names"`. | `tools` (default `DEFAULT_TOOLS`) |
| `exclude_tools` | list of strings | optional | `excludeTools` |
| `extensions` | `"none"` \| `"all"` \| list of strings | optional; default `"none"` | `extensions` |
| `exclude_extensions` | list of strings | optional; error if set while `extensions` is not `"all"`: `"exclude_extensions requires extensions: all"` | `excludeExtensions` |
| `skills` | `"none"` \| `"all"` \| list of strings | optional; default `"none"` | `skills` |
| `context_files` | boolean | optional; default `false` | `contextFiles` |
| `system_prompt_mode` | `"append"` \| `"replace"` | optional; default `"append"` | `systemPromptMode` |
| `model` | string `provider/modelId` | optional; must contain `/` with non-empty parts on both sides of the **first** `/` (model ids may contain further `/`) | `model` |
| `thinking` | one of `THINKING_LEVELS` | optional | `thinking` |
| `allow_model_override` | boolean | optional; default `false` | `allowModelOverride` |
| `max_turns` | integer ≥ 1 | optional | `maxTurns` |

- Unknown fields: throw `"unknown field '<name>'"` (strictness prevents silent typos).
- Body = `body.trim()`.
- Our own tool names (`OWN_TOOL_NAMES`) in `tools` → throw `"sub-agents cannot use '<name>'"`.

### Tests (tests/agents.test.ts)

- Minimal valid file (only `description`) → defaults exactly as table.
- Each field valid case and each invalid case (at least one per row).
- `tools: true` → error (regression for the pi-subagents-lite bug).
- Project overrides user on same slug; distinct slugs both present; sorted output.
- Bad file does not prevent other files from loading; error recorded.
- Subdirectories and non-`.md` files ignored; invalid slug filename rejected.

---

## 6. Child session runner (Milestone 5) — src/extension-names.ts, src/runner.ts

### 6.1 src/extension-names.ts

Port `extractExtensionName` and `extensionPackageName`/`resolvePackageShortName` from
`pi-subagents-lite` (`src/agents/agent-runner.ts`, MIT — add a header comment crediting
"AlexParamonov/pi-subagents-lite (MIT)"). Clone for reference:
`git clone --depth 1 https://github.com/AlexParamonov/pi-subagents-lite /tmp/pi-subagents-lite`.

Export:

```ts
export function extensionNames(extPath: string): string[]; // lowercased: [pathDerivedName, packageShortName?] deduped
export function filterExtensions<T extends { path: string; resolvedPath: string }>(
  exts: T[], spec: ExtensionsSpec, exclude: string[], ownPackageDir: string,
): { kept: T[]; unmatched: string[] };
```

`filterExtensions` rules:
1. **Always** drop any extension whose `resolvedPath` (after `path.resolve`) starts with
   `ownPackageDir + path.sep` (prevents nesting / self-loading).
2. `spec === "none"` → keep nothing.
3. `spec === "all"` → keep all except those whose `extensionNames` intersect `exclude` (lowercased).
4. `spec` is a list → keep those whose `extensionNames` intersect the list (lowercased).
5. `unmatched` = requested names (list or exclude) that matched no extension (for warnings).

`ownPackageDir` is computed once in `src/index.ts`:
`path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")` (the package root, since
`src/index.ts` is one level below it).

Tests: git-installed path, npm scoped path, local `extensions/foo.ts`, local
`extensions/foo/index.ts`, own-package exclusion, list/all/exclude/none, unmatched reporting. Use
fixture directories in a temp dir (with `package.json` containing `pi.extensions`) for the
package-short-name case.

### 6.2 Model and thinking resolution (pure function in runner.ts)

```ts
export function resolveModelChoice(input: {
  agent: AgentDefinition; task: TaskInput;
  parentModel: Model<any> | undefined; parentThinking: ThinkingLevel | undefined;
  find: (provider: string, id: string) => Model<any> | undefined;
}): { model: Model<any>; thinking: ThinkingLevel | undefined; overrideIgnored: boolean } // throws Error on problems
```

1. If `agent.allowModelOverride` is false: treat `task.model` and `task.thinking` as unset (do
   **not** throw). `overrideIgnored` = true if either was set, else false. If true, use the
   original values only for this flag.
2. Model string = `task.model ?? agent.model` (after step 1). If set: split at first `/`, `find(provider, id)`;
   not found → throw `"model '<str>' not found"`. If unset: use `parentModel`; if that is undefined →
   throw `"no model available (parent has no model selected)"`.
3. Thinking = `task.thinking ?? agent.thinking ?? parentThinking` (after step 1; may be undefined → Pi decides).

### 6.3 runChild — src/runner.ts

```ts
export interface RunChildOptions {
  agent: AgentDefinition;
  task: TaskInput;
  cwd: string;
  agentDir: string;
  ctx: ExtensionContext;               // parent ctx (model registry etc.)
  ownPackageDir: string;
  graceTurns: number;
  signal: AbortSignal;                 // aborts this child
  onEvent: (event: AgentSessionEvent) => void; // every child event
  onStarted: (info: { model: string; thinking?: ThinkingLevel; overrideIgnored: boolean }) => void;
  warn: (message: string) => void;
}
export interface RunChildResult {
  status: "completed" | "failed" | "aborted" | "turn_limited";
  text: string;                        // final assistant text ("" if none)
  error?: string;
  usage: RunUsage;
}
export async function runChild(opts: RunChildOptions): Promise<RunChildResult>;
```

**Must never throw**: wrap everything; any exception → `{status: "failed", error: message, text: ""}`.

Steps, in order:

1. `const { model, thinking, overrideIgnored } = resolveModelChoice(...)` using `ctx.model`, `ctx.thinkingLevel`,
   `(p, id) => ctx.modelRegistry.find(p, id)`.
2. `const settingsManager = SettingsManager.create(cwd, agentDir);`
3. Build the loader:
   ```ts
   const loader = new DefaultResourceLoader({
     cwd, agentDir, settingsManager,
     noExtensions: agent.extensions === "none",
     noSkills: agent.skills === "none",
     noPromptTemplates: true,
     noThemes: true,
     noContextFiles: !agent.contextFiles,
     extensionsOverride: (base) => {
       const { kept, unmatched } = filterExtensions(base.extensions, agent.extensions, agent.excludeExtensions, ownPackageDir);
       for (const n of unmatched) warn(`agent '${agent.slug}': extension '${n}' not found`);
       return { ...base, extensions: kept };
     },
     skillsOverride: Array.isArray(agent.skills)
       ? (base) => ({ ...base, skills: base.skills.filter((s) => (agent.skills as string[]).includes(s.name)) })
       : undefined,
     systemPromptOverride: agent.systemPromptMode === "replace"
       ? () => [agent.body, CHILD_PROMPT_FOOTER].filter(Boolean).join("\n\n")
       : undefined,
     appendSystemPromptOverride: agent.systemPromptMode === "append"
       ? (base) => [...base, [agent.body, CHILD_PROMPT_FOOTER].filter(Boolean).join("\n\n")]
       : undefined,
   });
   await loader.reload();
   ```
   (`Skill.name` is verified to exist.)
4. Shared model runtime (so providers/auth registered in the parent work in the child):
   ```ts
   const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
   ```
   Pass it only if it is defined; otherwise omit (Pi creates one from `agentDir`).
5. Tool allowlist:
   ```ts
   const excludeTools = [...agent.excludeTools, ...OWN_TOOL_NAMES];
   const tools = agent.tools.filter((t) => !excludeTools.includes(t));
   ```
6. Create:
   ```ts
   const { session } = await createAgentSession({
     cwd, agentDir, model, thinkingLevel: thinking, tools, excludeTools,
     resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager,
     ...(modelRuntime ? { modelRuntime } : {}),
   });
   ```
   Omit `thinkingLevel` if `thinking` is undefined.
7. `session.setSessionName(\`${agent.slug}:${task.name ?? ""}\`)` (optional cosmetic).
8. `await session.bindExtensions({ onError: (e) => warn(\`agent '${agent.slug}' extension error: ${e.extensionPath}: ${e.error}\`) })`.
   (`ExtensionBindings.onError` is verified to exist; pass only `onError`.)
9. Enforce the tool set after extensions bound (extensions may have activated extra tools):
   ```ts
   const available = new Set(session.getAllTools().map((t) => t.name));
   for (const t of tools) if (!available.has(t)) warn(`agent '${agent.slug}': tool '${t}' not available`);
   session.setActiveToolsByName(tools.filter((t) => available.has(t)));
   ```
10. `onStarted({ model: \`${model.provider}/${model.id}\`, thinking: session.thinkingLevel, overrideIgnored })`.
11. Subscribe: `const unsub = session.subscribe((e) => { try { onEvent(e) } catch {} ; turnTracker(e) })`.
12. Turn tracking (`max_turns`), inside the same listener: on `turn_end` increment `turns`.
    If `agent.maxTurns` set: when `turns === maxTurns` → `turnLimited = true; void session.steer(TURN_LIMIT_STEER).catch(() => {})`.
    When `turns >= maxTurns + graceTurns` and not yet aborted → `forcedAbort = true; void session.abort().catch(() => {})`.
13. Abort wiring: if `signal.aborted` before prompt → skip prompt, status `aborted`. Otherwise
    `signal.addEventListener("abort", () => void session.abort().catch(() => {}), { once: true })`.
14. `await session.prompt(task.prompt)` inside try/catch (catch → record error).
15. Determine result:
    - `text = session.getLastAssistantText() ?? ""`.
    - Find the last assistant message in `session.messages` (role `"assistant"`); if its
      `stopReason === "error"` → error = its `errorMessage ?? "model error"`.
    - Status precedence: `signal.aborted` → `"aborted"`; `forcedAbort` → `"turn_limited"`;
      caught exception or model error → `"failed"`; `turnLimited` → `"turn_limited"`;
      else `"completed"`.
    - Usage from `session.getSessionStats()`: `{turns, toolCalls, tokens, cost}`.
16. `finally`: `unsub()`, remove abort listener, `session.dispose()` (in try/catch).

### Tests (tests/runner.test.ts)

- `resolveModelChoice`: all branches (override ignored + `overrideIgnored: true` when disallowed, override applied when allowed, frontmatter model, not
  found, inherit, no model; thinking precedence).
- `runChild` with module mocking: use `mock.module("@earendil-works/pi-coding-agent", ...)` from
  `bun:test` to replace `createAgentSession`, `DefaultResourceLoader`, `SessionManager`,
  `SettingsManager` with fakes. The fake session emits scripted events on `prompt()`. Assert:
  tools passed and `setActiveToolsByName` called with the filtered list; own tools excluded;
  `noExtensions` true by default; `appendSystemPromptOverride` appends body + footer; max_turns
  steer at limit and abort after grace; abort signal → `aborted`; thrown error → `failed` (no
  throw); `dispose` always called.

---

## 7. Concurrency limiter — src/semaphore.ts (Milestone 6)

```ts
export class Semaphore {
  constructor(max: number);
  acquire(signal?: AbortSignal): Promise<() => void>; // resolves with release fn; rejects with AbortError if signal aborts while queued (and removes itself from the queue)
  get running(): number;
  get queued(): number;
  setMax(max: number): void; // takes effect as slots free up
}
```

Strict FIFO. `release` is idempotent. Tests: FIFO order, max respected, abort while queued removes
waiter, release idempotent, `setMax` increase drains queue.

---

## 8. Results — src/results.ts (Milestone 6)

```ts
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number };
export async function finalizeResult(input: {
  record: RunRecord; text: string; maxResultBytes: number; overflowRoot: string; parentSessionId: string;
}): Promise<{ inlineText: string; outputPath?: string }>;
export function formatRunResult(record: RunRecord, inlineText: string): string;
```

- `truncateUtf8`: cut at a UTF-8 boundary (never split a code point) so that byte length ≤ max.
- `finalizeResult`: if `Buffer.byteLength(text) <= maxResultBytes` → inline = text, no file. Else
  write the full text to `path.join(overflowRoot, sanitize(parentSessionId), \`${record.id}.md\`)`
  (`mkdir -p`, mode 0o600 file), inline = truncated text. `overflowRoot` = config `overflowDir` ??
  `path.join(os.tmpdir(), "super-agents-pi")`. `sanitize` replaces anything not `[A-Za-z0-9._-]` with `_`.
- `formatRunResult` produces exactly:

  ```
  ### <name> (<slug>) — <status> [id: <id>]
  <inlineText, or "(no output)" if empty>
  ```
  followed, when applicable, by lines:
  - `[output truncated — full result (<N> bytes): <outputPath>]`
  - `[error: <error>]`
  - `[note: requested model/thinking ignored — agent '<slug>' does not allow overrides]` when `record.overrideIgnored`
- Tests: ASCII and multi-byte truncation boundaries; no file when small; file written and path
  returned when large; formatting for each status.

---

## 9. Events — src/truncate.ts, src/events.ts (Milestone 7)

### 9.1 src/truncate.ts

```ts
export function boundJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; bytes: number };
```

Algorithm (deterministic):
1. Serialize with a safe replacer (handle `bigint` → string, functions → undefined, circular → `"[Circular]"`,
   `Uint8Array`/`Buffer` → `"[binary N bytes]"`). If byte length ≤ max → return the cloned value, `truncated: false`.
2. Let `limit = Math.floor(maxBytes / 4)`. Loop: deep-clone replacing every string longer than
   `limit` chars with `str.slice(0, limit) + "…[truncated " + (str.length - limit) + " chars]"`, and every
   array longer than 200 items with the first 200 plus a string marker. Re-measure. If ≤ max →
   return, `truncated: true`. Else `limit = Math.floor(limit / 2)`; stop looping when `limit < 64`.
3. Fallback: return `{ type: (value as any)?.type, truncated: true, originalBytes }`.

Tests: small value untouched; large string field truncated and result ≤ max; many medium strings;
circular; fallback path.

### 9.2 Event shaping — src/events.ts

```ts
export interface EventContext { agentId: string; name: string; slug: string; parentToolCallId: string; background: boolean }
export class EventEmitter {
  constructor(opts: { append: (customType: string, data: unknown) => void; config: SuperAgentsConfig });
  lifecycle(ctx: EventContext, phase: "queued" | "started" | "finished", data?: Record<string, unknown>): void;
  session(ctx: EventContext, event: AgentSessionEvent): void;
}
export function shapeSessionEvent(event: AgentSessionEvent): unknown | undefined;
```

`shapeSessionEvent`:
- `message_update` → drop (`undefined`). Streaming deltas are not forwarded; `message_end`
  carries the complete message. Not configurable.
- `entry_appended` → drop (`undefined`); the child's in-memory session entries are noise.
- Everything else → as-is.

Entry payload written with `append(EVENT_ENTRY_TYPE, payload)`:

```ts
{
  v: 1,
  seq: number,              // per-agent, starts at 0, increments per emitted entry
  ts: number,               // Date.now()
  agentId, name, slug, parentToolCallId, background,
  kind: "lifecycle" | "session",
  // lifecycle:
  phase?: "queued" | "started" | "finished",
  data?: {...},             // started: {model, thinking}; finished: {status, error?, usage, outputPath?, resultPreview (first 2 KiB)}
  // session:
  event?: unknown,          // shaped + bounded event
  truncated?: boolean,
}
```

- Apply `boundJson` to the **whole payload** with `config.maxEventBytes`; set `truncated`.
- If `config.events.enabled === false` → no-op.
- `append` errors are caught and ignored (never break a run because of telemetry).

Tests: each shaping mode; seq increments per agent; disabled → nothing appended; oversized event is
bounded.

**Note to implementer:** these entries are persisted in the parent's session file (accepted by the
user). Do not add any extra persistence.

---

## 10. Manager — src/manager.ts (Milestone 8)

The manager owns all runs for the current parent session. It is created in `src/index.ts` and
replaced on each `session_start`.

```ts
export interface ManagerDeps {
  config: SuperAgentsConfig;
  getAgents: () => Map<string, AgentDefinition>;
  runChild: typeof runChild;                     // injectable for tests
  emitter: EventEmitter;
  pushResult: (text: string, details: unknown) => void; // background delivery (see §10.4)
  cwd: string; agentDir: string; ownPackageDir: string; parentSessionId: string; overflowRoot: string;
  warn: (msg: string) => void;
}
export class RunManager {
  constructor(deps: ManagerDeps);
  startTasks(args: { tasks: TaskInput[]; background: boolean; parentToolCallId: string; ctx: ExtensionContext;
                     signal?: AbortSignal; onProgress?: (records: RunRecord[]) => void }): { records: RunRecord[]; done: Promise<void> };
  wait(ids: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ finished: RunRecord[]; pending: RunRecord[] }>;
  stop(idsOrNames: string[]): { stopped: string[]; notFound: string[]; alreadyFinished: string[] };
  status(): RunRecord[];
  shutdown(): void; // abort everything, reject nothing, clear timers
}
```

### 10.1 startTasks

1. Validate **all** tasks before starting any (fail the whole call on the first problem, throw
   Error with a clear message):
   - `tasks.length` between 1 and `config.maxTasksPerCall`.
   - `agent` exists in `getAgents()` → else `"unknown agent '<x>'. Available: a, b, c"`.
   - `prompt` non-empty after trim.
2. For each task create a `RunRecord`: id = 8 random chars from `[a-z0-9]` via `crypto.randomInt`
   (regenerate on collision); name = `task.name?.trim() || slug`; if the name is already used by a
   non-finished run (or earlier in this batch), append `-2`, `-3`, … until unique; status `queued`.
   Store in `records: Map<id, RunRecord>`. Emit lifecycle `queued`.
3. For each record start an async job (do not await in the loop):
   1. `release = await semaphore.acquire(abortController.signal)` (queued abort → status `aborted`, finish).
   2. status `running`, `startedAt`.
   3. `await deps.runChild({... signal: abortController.signal, onEvent: (e) => emitter.session(evCtx, e),
      onStarted: (i) => { record.model = i.model; record.thinking = i.thinking; record.overrideIgnored = i.overrideIgnored; emitter.lifecycle(evCtx, "started", i) } })`.
   4. `finalizeResult(...)`; set status/usage/error/outputPath/resultText(inline)/endedAt.
   5. `release()`; emit lifecycle `finished`; call `onProgress` if foreground; resolve waiters (§10.3);
      if background and not `delivered` → enqueue for push (§10.4).
   Each record has its own `AbortController` kept in a private `Map<id, AbortController>`.
4. Foreground: if `signal` is provided, on its abort → abort every record of this call.
   `done` = `Promise.all(jobs)`. Call `onProgress(records)` on every status change and throttled
   (≤ 4/s) on child events (count tool calls per record from `tool_execution_start` for the summary).
5. Background: `done` still returned but the tool does not await it.

### 10.2 stop

Match each argument against record id first, then name (exact). Running/queued → abort controller;
report in `stopped`. Finished → `alreadyFinished`. No match → `notFound`. Stopped background runs
still get a pushed result (status `aborted`) unless consumed by a waiter.

### 10.3 wait

- `ids` undefined → all background records that are not `delivered`.
- Unknown ids → throw `"unknown agent id(s): …"`.
- Resolve when all listed records are finished, or on `timeoutMs`, or on `signal` abort.
- Return `finished` (mark them `delivered = true` so they are **not** pushed later) and `pending`.
- Implementation: keep a set of waiter callbacks; each job completion notifies waiters. A record
  that finishes while covered by an active waiter is **not** pushed (§10.4 checks `delivered` and
  the waiter set *at push time*, see below).

### 10.4 Background push

- On completion of a background record, add it to a pending-push list and (re)arm a
  `BACKGROUND_BATCH_MS` timer.
- When the timer fires: drop records that are now `delivered` or covered by an active waiter. For
  the rest, mark `delivered = true` and call `deps.pushResult(text, details)` **once** with all of
  them joined by `\n\n` (`formatRunResult` each), prefixed by
  `"Background sub-agent results:"`. `details = { runs: records.map(summary) }`.
- `pushResult` is implemented in `src/index.ts` (see §11.4).

### 10.5 status

Returns all records (newest first). The tool formats them.

### 10.6 shutdown

Abort all controllers, clear timers, clear waiters (resolve them with what's finished). Do not push.

### Tests (tests/manager.test.ts) — use a fake `runChild`

- Validation errors (count, unknown agent listing available, empty prompt). A disallowed model/thinking
  override does **not** fail validation; the run proceeds and `overrideIgnored` is set.
- Names unique with suffixes; ids 8 chars, unique.
- Concurrency: with `maxConcurrent: 2` and 4 tasks, never more than 2 fake runs active; FIFO order.
- Foreground abort aborts all its records, including queued ones.
- Background: completion pushes once, batching two near-simultaneous completions into one push.
- `wait` returns results and suppresses push; timeout returns pending.
- `stop` by id and by name; already finished; not found.
- `shutdown` aborts running runs and pushes nothing.
- Lifecycle events emitted in order queued → started → finished.

---

## 11. Tools and extension wiring (Milestone 9) — src/tool-defs.ts, src/index.ts

### 11.1 Tool schemas (src/tool-defs.ts)

```ts
export function buildAgentToolParams(agents: AgentDefinition[], cfg: SuperAgentsConfig): TSchema;
export function buildAgentToolDescription(agents: AgentDefinition[]): string;
```

`agent` tool parameters:

```ts
Type.Object({
  tasks: Type.Array(Type.Object({
    agent: agents.length ? StringEnum(agents.map(a => a.slug)) : Type.String(),
    prompt: Type.String({ description: "Complete, self-contained instructions. The sub-agent cannot see this conversation." }),
    name: Type.Optional(Type.String({ description: "Optional label for this run" })),
    // Only include these two if ANY agent has allowModelOverride:
    model: Type.Optional(Type.String({ description: "provider/model — applied only for agents marked [overridable]; ignored otherwise" })),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  }, { additionalProperties: false }), { minItems: 1, maxItems: cfg.maxTasksPerCall }),
  background: Type.Optional(Type.Boolean({ description: "Return immediately; results arrive later as a message" })),
}, { additionalProperties: false })
```

Description text (exact template; keep it short — it is the only advertising):

```
Run tasks on specialised sub-agents. Each task runs in a fresh isolated session with the agent's own tools and model, and returns the agent's final answer. Tasks in one call run in parallel. Sub-agents cannot see this conversation, so each prompt must contain all needed context. Use background: true to keep working while they run; results arrive automatically as a message (or use agent_wait).

Agents:
- <slug>: <description>[ [overridable]]
...
```

If there are no agents: `"No sub-agents are configured. Agent definitions live in ~/.pi/agent/agents/*.md or .pi/agents/*.md."`
Set `promptSnippet` to `"Delegate tasks to sub-agents: " + slugs.join(", ")` (or omit when none).

Other tools:

| Tool | Params | Description |
|---|---|---|
| `agent_wait` | `{ ids?: string[], timeout_seconds?: integer 1..3600 (default 600) }` | "Wait for background sub-agents to finish and return their results. Omit ids to wait for all undelivered background runs." |
| `agent_stop` | `{ ids: string[] (minItems 1) }` (ids or names) | "Abort running or queued sub-agents by id or name." |
| `agent_status` | `{}` | "List sub-agent runs with status. Do not poll; results are delivered automatically." |

Tests (tests/tool-defs.test.ts): enum contains slugs; model/thinking present only when some agent
allows override; description lists agents and `[overridable]` marker; empty-agents text.

### 11.2 Extension entry (src/index.ts)

```ts
export default function superAgents(pi: ExtensionAPI): void
```

Module state (inside the closure): `ownPackageDir`, `agents: Map<slug, AgentDefinition>`,
`config`, `manager: RunManager | undefined`, `latestCtx: ExtensionContext | undefined`.

1. `pi.on("session_start", (_e, ctx) => { ... })`:
   1. `latestCtx = ctx`.
   2. `manager?.shutdown()`.
   3. `const agentDir = getAgentDir();` `const { config, warnings } = loadConfig(ctx.cwd, agentDir);`
   4. `const { agents: list, errors } = loadAgents(ctx.cwd, agentDir);` → rebuild `agents` map.
   5. Report `warnings` and `errors` via `ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.error(msg)`
      (one line each, prefixed `super-agents-pi:`).
   6. Create a new `EventEmitter({ append: (t, d) => pi.appendEntry(t, d), config })` and a new
      `RunManager(...)` with `parentSessionId = ctx.sessionManager.getSessionId()`.
   7. Register (or re-register — same name replaces) the four tools via `pi.registerTool(...)` using
      `buildAgentToolParams(list, config)` / `buildAgentToolDescription(list)`.
2. `pi.on("session_shutdown", () => { manager?.shutdown(); manager = undefined; })`.
3. **Registration timing check (do this during Milestone 9 manually):** confirm tools registered in
   `session_start` are visible to the model on the first turn (run `pi`, ask "what tools do you
   have?"). If they are not, additionally register all four tools once at extension load time using
   `loadAgents(process.cwd(), getAgentDir())`, and keep the re-registration in `session_start`.

### 11.3 Tool execute functions

`agent`:
```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  latestCtx = ctx;
  const { records, done } = manager.startTasks({ tasks: params.tasks, background: !!params.background,
    parentToolCallId: toolCallId, ctx, signal: params.background ? undefined : signal,
    onProgress: params.background ? undefined : (recs) => onUpdate?.({
      content: [{ type: "text", text: recs.map(r => `${r.name}: ${r.status}`).join("\n") }],
      details: { runs: recs.map(summary) },
    }) });
  if (params.background) {
    return { content: [{ type: "text", text:
      "Started in background:\n" + records.map(r => `- ${r.name} (${r.slug}) [id: ${r.id}]`).join("\n") +
      "\nResults will arrive automatically as a message." }], details: { runs: records.map(summary) } };
  }
  await done;
  for (const r of records) r.delivered = true;
  return { content: [{ type: "text", text: records.map(r => formatRunResult(r, r.resultText ?? "")).join("\n\n") }],
           details: { runs: records.map(summary) } };
}
```
Validation errors thrown by `startTasks` propagate (Pi turns a thrown error into an error tool result).
`summary(r)` = `{ id, name, slug, status, model, thinking, usage, error, outputPath, durationMs }`.

`agent_wait`: call `manager.wait(ids, timeout_seconds*1000, signal)`; text = finished results via
`formatRunResult` + a line per pending run `"- <name> [id] still <status>"`.

`agent_stop`: call `manager.stop(ids)`; text lists stopped / already finished / not found.

`agent_status`: table-like text lines `"<id>  <name>  <slug>  <status>  <duration>s"`; `"No sub-agent runs."` if empty.

All four: throw `"super-agents-pi is not initialised"` if `manager` is undefined.

### 11.4 pushResult (background delivery)

```ts
pushResult: (text, details) => pi.sendMessage(
  { customType: RESULT_MESSAGE_TYPE, content: text, display: true, details },
  { triggerTurn: true, deliverAs: latestCtx?.isIdle() === false ? "steer" : "followUp" },
)
```

Wrap in try/catch; on failure `console.error`.

### Tests (tests/index.test.ts)

Follow the `mockPi()` pattern in `packages/pi-microgpt/tests/apply-patch.test.ts`. Mock
`getAgentDir` via `mock.module` or set `PI_CODING_AGENT_DIR` to a temp dir containing `agents/` and
`settings.json`. Assert: `session_start` registers 4 tools; the agent enum matches files; re-running
`session_start` after adding a file updates the enum; `session_shutdown` calls manager shutdown;
background execute returns ids immediately; foreground execute returns formatted results (use a
fake runner by injecting via a test-only export, e.g. `export function __setRunChildForTests(fn)`).

---

## 12. README.md (Milestone 10)

Sections:
1. What it is (one paragraph) and install: `pi install npm:@mcowger/super-agents-pi`.
2. Agent files: locations, precedence, full frontmatter table (copy §5 table), example:
   ```markdown
   ---
   description: Read-only codebase explorer that answers questions with file:line references
   tools: [read, grep, find, ls, bash]
   model: anthropic/claude-haiku-4-5
   thinking: low
   max_turns: 30
   ---
   You explore code and report findings concisely with file:line references. Never modify files.
   ```
3. Config: `superAgents` block with every key, default, and meaning.
4. Tools exposed to the model (the four, with params).
5. **RPC event reference** for client authors: they arrive as `entry_appended` events whose
   `entry.customType === "super-agents-event"`; document the payload (§9.2) and the
   `super-agents-result` custom message; foreground progress is also in `tool_execution_update`
   for the `agent` tool. Note entries are persisted in the session file.
6. Limitations: in-process (a crashing child extension can affect the parent), no nesting, no
   client control channel, `max_turns` is enforced by steering then aborting.

---

## 13. Manual smoke test (Milestone 11)

1. `mkdir -p ~/.pi/agent/agents` and create `scout.md` (README example) and `writer.md` with
   `tools: [read, write, edit]`, `allow_model_override: true`.
2. Run pi with the local extension: `pi -e ./packages/super-agents-pi/index.ts`.
3. Ask: "Use the scout agent to find where settings are loaded." → foreground result appears.
4. Ask for two scouts in parallel with `background: true`, keep chatting → results arrive as a message.
5. Ask it to call `agent_stop` on a running background agent → aborted result.
6. RPC: `pi --mode rpc -e ./packages/super-agents-pi/index.ts`, send
   `{"type":"prompt","message":"use scout to list files"}` and confirm stdout contains
   `entry_appended` lines with `customType":"super-agents-event"` including `tool_execution_start`
   with `args`, and `tool_execution_end` with `result`.
7. Put a `.pi/agents/scout.md` in the project with a different description → project version wins
   after `/reload`.
8. Confirm a child never has the `agent` tool (ask scout: "list your tools").

---

## 14. Milestone checklist

| # | Deliverable | Done when |
|---|---|---|
| 1 | Scaffold + root wiring | `bun run check` passes |
| 2 | constants.ts, types.ts | compiles |
| 3 | config.ts + tests | tests pass |
| 4 | agents.ts + tests | tests pass |
| 5 | extension-names.ts, runner.ts + tests | tests pass |
| 6 | semaphore.ts, results.ts + tests | tests pass |
| 7 | truncate.ts, events.ts + tests | tests pass |
| 8 | manager.ts + tests | tests pass |
| 9 | tool-defs.ts, index.ts + tests | tests pass; registration timing verified |
| 10 | README.md | written |
| 11 | Manual smoke test | all 8 steps pass |

Commit after each milestone (conventional commits, e.g. `feat(super-agents-pi): add agent discovery`).
Do **not** run Cora reviews (repo rule).

---

## 15. Rules for the implementer

- Do not add features not in this plan (no TUI, no worktrees, no chains/workflows, no built-in agents,
  no follow-up messages to finished agents, no client control channel, no nesting).
- Do not spawn processes. Do not import `child_process`.
- Never let telemetry (events) or one child's failure break another child or the parent.
- Every `AgentSession` created must be `dispose()`d exactly once.
- All user-visible and model-visible text in English.
- If a verified SDK fact in §1 turns out wrong at runtime, stop and report it rather than guessing.

## 16. Known risks (accepted)

- **Persisted events**: `appendEntry` writes every child event into the parent session file. Mitigated
  by dropping all `message_update` events and per-event byte bounds. Set `events.enabled: false` if
  files grow too large.
- **Shared ModelRuntime** via a TS-private field: if Pi renames it, we fall back to a fresh runtime
  (auth from `auth.json`), which loses providers registered by parent-only extensions.
- **In-process**: an extension loaded into a child that throws synchronously or leaks can affect the
  parent process.
