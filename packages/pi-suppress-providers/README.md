# pi-suppress-providers

A [pi](https://github.com/earendil-works/pi-mono) extension that limits which providers appear in model selection, even when API keys for other providers are present in the environment.

## Problem

Pi makes all providers available whenever their API keys are found in the environment. For example, if `OPENROUTER_API_KEY` is set, all OpenRouter models appear in the model selector regardless of what you want. The same happens with `GH_TOKEN` and GitHub Copilot models, or any other provider with a key in your env.

## Solution

This extension reads `enabledProviders` from `settings.json` and temporarily removes credentials for non-enabled providers before pi loads its model registry. After pi resolves which models are available, the env vars are restored so they remain accessible to bash commands and other tools.

## Installation

### Option 0: From the pi-plugins monorepo

```bash
pi install ./packages/pi-suppress-providers
```

### Option 1: As an npm package (recommended)

```bash
pi install @mcowger/pi-suppress-providers
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "enabledProviders": ["openrouter"],
  "packages": ["npm:@mcowger/pi-suppress-providers"]
}
```

### Option 2: As a local path package

Add to `~/.pi/agent/settings.json`:

```json
{
  "enabledProviders": ["openrouter"],
  "packages": ["/path/to/pi-suppress-providers"]
}
```

### Option 3: Copy to extensions directory

```bash
cp -r /path/to/pi-suppress-providers ~/.pi/agent/extensions/
```

### Option 4: One-off with --extension flag

```bash
pi --extension /path/to/pi-suppress-providers/index.ts
```

## Configuration

In pi's resolved `settings.json` (default `~/.pi/agent/settings.json`, or the path specified by `PI_CODING_AGENT_DIR`), add the `enabledProviders` array with the provider names you want to keep:

```json
{
  "enabledProviders": ["openrouter"]
}
```

With this config, only OpenRouter models will be available. All other providers (anthropic, openai, copilot, etc.) are hidden from model selection.

If `enabledProviders` is not set or is empty, the extension does nothing.

## How It Works

1. At extension load time (before pi resolves models), reads `enabledProviders` from `settings.json`
2. Temporarily deletes the env vars for all non-enabled providers
3. Pi's model registry sees no auth for those providers, so they don't appear in `getAvailable()`
4. On `session_start`, restores the env vars so bash commands and other tools can still use them

## Supported Providers

Provider names must match Pi's internal names. The extension discovers Pi's built-in providers and API-key environment variables dynamically, so support automatically follows the installed Pi version. It also suppresses Pi's ambient Amazon Bedrock and Google Vertex credentials.

Providers that share a credential environment variable cannot be hidden independently. If that variable is needed by an enabled provider, it remains available and Pi may show every provider that uses it.
