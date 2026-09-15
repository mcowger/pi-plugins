# pi-microgpt API

This document describes the commands, tool parameters and results, and RPC notifications exposed by `pi-microgpt`.

## Commands

Commands are registered with Pi and can be invoked in a TUI with slash commands. In RPC mode, invoke them through Pi's normal `prompt` command, for example:

```json
{"type":"prompt","id":"prompt-1","message":"/fast {\"action\":\"status\",\"requestId\":\"fast-1\"}"}
```

The extension reports command results with Pi's `ui.notify` API. In RPC mode, the outer event has this shape:

```json
{
  "type": "extension_ui_request",
  "id": "<Pi-generated event ID>",
  "method": "notify",
  "message": "<JSON-encoded pi-microgpt.response>",
  "notifyType": "info"
}
```

`message` is a string containing the response object below. `notifyType` is `info` for success and `warning` for invalid or unsupported operations. Pi generates the outer event `id`; use `requestId` to correlate a command with its response.

### Request arguments

The `fast`, `long-context`, `web-search`, and `subagents` commands accept a plain action or a JSON object:

```text
/fast on
/fast {"action":"on","requestId":"fast-1"}
```

JSON requests have this shape:

```ts
type CommandRequest = {
  action: "toggle" | "on" | "off" | "status";
  requestId?: string;
};
```

Unknown fields, a missing or non-string `action`, and a non-string `requestId` make a JSON request invalid. Action matching is case-insensitive. An empty argument toggles the feature.

The `*-status` aliases accept no argument, a plain correlation ID, or a JSON status request:

```text
/fast-status
/fast-status fast-2
/fast-status {"action":"status","requestId":"fast-3"}
```

A JSON request to a status alias must use `"action":"status"`.

### Response payload

The JSON string in the RPC notification's `message` follows this shape:

```ts
type CommandResponse = {
  type: "pi-microgpt.response";
  command: "fast" | "long-context" | "web-search" | "subagents";
  success: boolean;
  requestId?: string;
  enabled?: boolean;
  supported?: boolean;
  provider?: string;
  model?: string;
  api?: string;
  contextWindow?: number;
  error?: string;
};
```

Fields not relevant to a command or unavailable in the current context are omitted. Invalid requests and failed state changes return `success: false` and an `error` string. A status query on an unsupported model still succeeds and reports `supported: false`.

Example:

```json
{
  "type": "pi-microgpt.response",
  "command": "fast",
  "success": true,
  "requestId": "fast-1",
  "enabled": false,
  "supported": true,
  "provider": "plexus",
  "model": "gpt-5.6-luna",
  "api": "openai-responses"
}
```

### Command behavior

| Command | Behavior |
| --- | --- |
| `fast` | Toggles or sets Fast mode. `status` reports its session setting. |
| `fast-status` | Reports Fast mode. |
| `long-context` | Toggles or sets long context. Repeating `on` or `off` is safe. |
| `long-context-status` | Reports long-context state and the current context window. |
| `web-search` | Toggles or sets web search. |
| `web-search-status` | Reports the web-search setting. |
| `subagents` | Toggles or sets the subagent tools. |
| `subagents-status` | Reports the subagent-tools setting. |

All four settings start disabled in each session. Long context is restored when switching models and at session shutdown. Fast mode adds `service_tier: "priority"` only to requests for the active supported model. Web search and subagent tools are callable only on a supported model; their `enabled` fields report the session setting, while `supported` reports model eligibility.

Supported models use the `openai-responses` or `openai-codex-responses` API and a GPT 5.5+ model ID. Provider names do not affect eligibility.

## Tools

Tool inputs are JSON objects validated by Pi against each tool's registered schema. Successful tools return Pi `content` blocks and optional `details`; tool failures use Pi's normal tool-error handling rather than a `pi-microgpt.response` command notification.

### `apply_patch`

Replaces Pi's active `edit` and `write` tools on supported models when file-editing tools were selected at startup.

```ts
type ApplyPatchInput = {
  patch: string; // Complete Codex *** Begin Patch ... *** End Patch text
};
```

The extension parses and applies the patch in TypeScript. Success returns text content and details:

```ts
type ApplyPatchDetails = {
  files: {
    kind: "add" | "update" | "delete";
    path: string;
    moveTo?: string;
    added?: number;
    removed?: number;
    diff?: string;
  }[];
};
```

### `web_search`

Available after `/web-search on` on supported models. Each operation is optional; send the fields needed for the request.

```ts
type WebSearchInput = {
  search_query?: SearchQuery[]; // Up to 4
  image_query?: SearchQuery[];  // Up to 2
  open?: { ref_id: string; lineno?: number }[];
  click?: { ref_id: string; id: number }[];
  find?: { ref_id: string; pattern: string }[];
  screenshot?: { ref_id: string; pageno: number }[];
  finance?: { ticker: string; type: "equity" | "fund" | "crypto" | "index"; market?: string }[];
  weather?: { location: string; start?: string; duration?: number }[];
  sports?: {
    tool?: "sports";
    fn: "schedule" | "standings";
    league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
    team?: string;
    opponent?: string;
    date_from?: string;
    date_to?: string;
    num_games?: number;
    locale?: string;
  }[];
  time?: { utc_offset: string }[];
  response_length?: "short" | "medium" | "long";
};

type SearchQuery = {
  q: string;
  recency?: number; // Non-negative integer
  domains?: string[];
};
```

The tool sends the active model, session ID, recent conversation input, commands, and web-access settings to the resolved Codex search endpoint. The successful Pi result contains the service's output as text and details with the submitted commands, bounded raw output, and provider results:

```ts
type WebSearchDetails = {
  commands: WebSearchInput;
  rawOutput: string; // Truncated at 50,000 UTF-8 bytes
  results?: unknown[];
};
```

### Multi-agent tools

These six tools are available after `/subagents on` on supported models. Their successful `content[0].text` is a pretty-printed JSON encoding of the same object stored in `details`.

| Tool | Input | Success details |
| --- | --- | --- |
| `spawn_agent` | `{ task_name: string, message: string, fork_turns?: string, agent_type?: string, model?: string, reasoning_effort?: ThinkingLevel }` | `{ task_name: string, status: AgentStatus }` |
| `send_message` | `{ target: string, message: string }` | `{ target: string, queued: true }` |
| `followup_task` | `{ target: string, message: string }` | `{ target: string, status: AgentStatus }` |
| `wait_agent` | `{ timeout_ms?: number }` | `{ message: string, timed_out: boolean }` |
| `list_agents` | `{ path_prefix?: string }` | `{ agents: { agent_name: string, agent_status: AgentStatus }[] }` |
| `interrupt_agent` | `{ target: string }` | `{ previous_status: AgentStatus }` |

`ThinkingLevel` is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. `fork_turns` is `"none"`, `"all"` (the default), or a positive integer encoded as a string. Full-history forks (`"all"`) cannot set `model` or `reasoning_effort`. A model override can be `provider/model` or a model ID for the inherited provider; it must resolve to a supported GPT 5.5+ Responses API model. Agent names use lowercase letters, digits, and underscores. `target` accepts a relative child name or canonical path.

`AgentStatus` is:

```ts
type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };
```

## Fast-mode provider request

When enabled, the `before_provider_request` hook returns the request payload with `service_tier` set to `"priority"` if its `model` matches the active supported model. Other payloads are unchanged.

## Web-search HTTP contract

The extension sends a JSON `POST` to the resolved Codex search endpoint. The request body has this shape:

```ts
type CodexSearchRequest = {
  id: string; // Pi session ID
  model: string;
  input?: Array<Record<string, unknown>>;
  commands: WebSearchInput;
  settings: { allowed_callers: ["direct"]; external_web_access: true };
  max_output_tokens: 2000 | 5000 | 10000;
};
```

The token and model/auth headers are sent in HTTP headers, not in the body. A successful response must be JSON with a string `output`; the tool exposes that output as text. Non-2xx responses, invalid JSON, and responses without `output` become tool errors.
