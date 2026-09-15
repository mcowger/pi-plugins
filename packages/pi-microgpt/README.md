# pi-microgpt

One Pi extension for Codex-oriented workflows:

- `/long-context` raises supported GPT 5.5+ Responses API models to 1.05M tokens; it is disabled by default.
- `/fast` toggles `service_tier: "priority"` on supported GPT 5.5+ Responses API requests.
- `apply_patch` uses the native OpenAI Codex patch implementation.
- `web_search` is disabled by default and can be enabled with `/web-search on`.

The long-context and Fast checks use the model's API and slug, not its provider. A model must use a Responses API (`openai-responses` or `openai-codex-responses`) and match the GPT 5.5-or-later slug pattern.

## RPC

Every command emits exactly one JSON notification, including in RPC mode. Commands accept either normal arguments or a JSON request:

```text
/fast on
/fast {"action":"status","requestId":"req-42"}
/web-search {"action":"on","requestId":"req-43"}
/long-context-status req-44
```

Responses have the form `{"type":"pi-microgpt.response","command":"fast","success":true,...}`. Long context, Fast mode, and web search are session-only and start disabled. There is no settings persistence.

## Development

```sh
bun run check
bun test
```
