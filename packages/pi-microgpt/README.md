# pi-microgpt

`pi-microgpt` combines the Codex-focused parts of three Pi extensions into one
package:

- Long context for GPT 5.5+ Responses API models.
- Fast mode through `service_tier: "priority"` and Flex mode through `service_tier: "flex"`.
- Codex-compatible TypeScript `apply_patch`.
- Optional Codex web search.
- Optional Codex subagent tools.
- Hierarchical multi-agent collaboration with in-process Pi agent sessions.

It uses basic slash commands and machine-readable JSON notifications. There is
no custom TUI. See [API.md](./API.md) for command, tool, and RPC payload shapes.

## Install from Git

Clone this repository and install the package directory with Pi:

```sh
git clone https://github.com/mcowger/pi-plugins.git
cd pi-plugins
pi install ./packages/pi-microgpt
```

Restart Pi or run `/reload` after installing.

To try the checkout for one run without installing it:

```sh
pi --extension ./packages/pi-microgpt/index.ts
```

`apply_patch` is implemented in TypeScript and has no native binary dependency.

## Model support

Long context and Fast mode use the model's API and model ID. They do not limit
themselves to a provider name.

A model is supported when both conditions are true:

- Its API is `openai-responses` or `openai-codex-responses`.
- Its model ID matches GPT 5.5 or later, such as `gpt-5.5`, `gpt-5.6-sol`, or
  `gpt-6-astra`.

The model ID check uses a regex so later GPT versions and suffixes work without
an extension update. The extension does not claim that every future model has
a 1.05M context window. Check the model's documentation before using long
context with a new slug.

The same check controls all features except Flex mode, which additionally
requires a flex-supported model (see below). The provider does not matter, and the
model ID does not need to contain `codex`.

## Multi-agent tools

The plugin uses `pi-multiagents-v2` 0.1.2 (MIT) for its team manager and
collaboration tools. It does not load that package's extension entry point.

The tools are active only while the selected model passes the shared model
check. Each tool also checks the current model when it runs. Child agents
inherit the current model by default. A `spawn_agent` model override must
resolve to a supported GPT 5.5+ Responses API model, and the same restriction
applies when a child agent recursively spawns another agent.

When enabled on a supported model, available tools:

- `spawn_agent`: start a child for an independent task; supports `fork_turns`
  and an optional model override.
- `send_message`: send a message without waking an idle agent.
- `followup_task`: assign more work to an existing child.
- `wait_agent`: wait for new messages or steering input.
- `list_agents`: inspect the agent tree and statuses.
- `interrupt_agent`: stop a child turn while retaining its session.

Child sessions follow the parent's persistence policy and can be inspected
with Pi's `/resume` and `/tree` commands. Active teams are shut down when the
Pi session ends.

### Delegation hints

Child agents inherit the parent model and reasoning level by default. The
injected collaboration instructions suggest these starting points when an
override fits the task:

- Exploration or commit messages: `gpt-5.6-luna` with `low` reasoning.
- Implementation: `gpt-5.6-luna` with `xhigh` reasoning.
- Debugging or complex integration: `gpt-5.6-terra` with `high` reasoning.
- Deep brainstorming or design work: `gpt-5.6-sol` with `high` reasoning.

Subagent tools are off by default and session-only. Enable them explicitly:

```text
/subagents on
/subagents off
/subagents
/subagents status
/subagents-status
```

## Long context

Long context is off by default and is session-only. It raises the selected
supported model's context window to 1,050,000 tokens while enabled.

```text
/long-context              # toggle
/long-context on
/long-context off
/long-context status
/long-context-status
```

Switching models, reloading, starting a new session, and shutting down restore
the previous context window. The extension does not write this state to disk.

## Fast mode

Fast mode is off by default and is session-only. When enabled, supported
Responses API payloads receive:

```json
{
  "service_tier": "priority"
}
```

The patch only applies when the request's `model` field matches the active
model's ID.

```text
/fast
/fast on
/fast off
/fast status
/fast-status
```

Unsupported models are left unchanged.

## Flex mode

Flex mode is off by default and is session-only. When enabled, supported
Responses API payloads receive:

```json
{
  "service_tier": "flex"
}
```

Flex trades slower processing for lower cost. It is mutually exclusive with
Fast mode: enabling one disables the other. The patch only applies when the
request's `model` field matches the active model's ID.

```text
/flex
/flex on
/flex off
/flex status
/flex-status
```

Flex follows OpenAI's flex SKU, which is narrower than Fast mode. Within this
plugin's GPT 5.5+ scope, flex applies to `gpt-6-astra` and `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna` (plus dated snapshots and suffixes).
`gpt-5.5`, `gpt-5.4` and earlier, `gpt-5.6-cyber`, `gpt-4.1`, fine-tuned
models, and embeddings are left unchanged, and `/flex status` reports
`supported: false` for them. (`o3`, `o4-mini`, and the `gpt-5` family support
flex per OpenAI but sit outside this plugin's GPT 5.5+ scope.) Flex is in
beta and OpenAI lists supported models on its pricing page; sending flex to
an unsupported model returns a server `400`, which is why the plugin omits
the parameter there instead of failing the request.

## `apply_patch`

On a supported Codex model, the extension replaces Pi's active `edit` and
`write` tools with the native `apply_patch` tool. Switching away restores the
tools it removed.

The tool accepts the standard Codex patch format:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old line
+new line
*** End Patch
```

It supports adding, updating, moving, and deleting files. Patches run
sequentially through a TypeScript implementation of Codex-compatible parsing,
context matching, and file operations. Patch paths are resolved to real absolute
locations before delegating, so they are not confined to the session working
directory; access policy is enforced separately.

The tool is only enabled when Pi's normal file-editing tools were selected.
If `edit` and `write` were disabled before the extension loaded, `apply_patch`
stays disabled too.

## Web search

Web search is off by default and is session-only. Enable it explicitly:

```text
/web-search on
/web-search off
/web-search
/web-search status
/web-search-status
```

When enabled on a supported Codex model, Pi exposes `web_search` to the model.
It sends requests to the resolved Codex search endpoint and supports search,
image search, opening pages, clicking links, find-in-page, screenshots,
finance, weather, sports, and time operations.

The tool uses the active model's authentication and base URL. Search output is
returned to the model as text, while bounded raw output and provider results
remain in the tool details.

## RPC

All commands emit one JSON notification through Pi's extension UI channel.
The notification message is a JSON object with this shape:

```json
{
  "type": "pi-microgpt.response",
  "command": "fast",
  "success": true,
  "requestId": "req-42",
  "enabled": true,
  "serviceTier": "priority",
  "supported": true,
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "api": "openai-codex-responses"
}
```

`fast` and `flex` responses include `serviceTier`, the active tier across
both commands: `"priority"`, `"flex"`, or `"off"`. `enabled` reports the
queried command's own switch, so `/fast status` while Flex is active returns
`enabled: false` with `serviceTier: "flex"`.

Commands accept JSON arguments when an adapter needs a request ID or a stable
request format:

```text
/fast {"action":"on","requestId":"fast-1"}
/fast {"action":"status","requestId":"fast-2"}
/flex {"action":"on","requestId":"flex-1"}
/flex {"action":"status","requestId":"flex-2"}
/long-context {"action":"on","requestId":"context-1"}
/web-search {"action":"on","requestId":"search-1"}
```

The supported JSON fields are:

- `action`: `toggle`, `on`, `off`, or `status`.
- `requestId`: optional adapter-defined correlation ID.

Invalid commands return `success: false` and an `error` field. The status
aliases accept a plain request ID too:

```text
/fast-status req-3
/flex-status req-4
/long-context-status req-5
/web-search-status req-6
```

The plugin does not persist long-context, Fast mode, Flex mode, web-search, or subagent state.
Every session starts with all five disabled.

## Development

From the repository root:

```sh
bun install
bun run check
bun --cwd packages/pi-microgpt test
```

The pinned upstream `@paulpham157/apply-patch` dependency is covered by
`THIRD_PARTY_NOTICES.md`.
