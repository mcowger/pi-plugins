# Pi plugins

Monorepo for my Pi extensions and packages.

## Packages

| Package | npm | Description |
| --- | --- | --- |
| `pi-control` | [`@mcowger/pi-control`](https://www.npmjs.com/package/@mcowger/pi-control) | Action-based filesystem and tool-call policies |
| `pi-suppress-providers` | [`@mcowger/pi-suppress-providers`](https://www.npmjs.com/package/@mcowger/pi-suppress-providers) | Limits which providers appear in Pi's model picker |
| `pi-microgpt` | [`@mcowger/pi-microgpt`](https://www.npmjs.com/package/@mcowger/pi-microgpt) | GPT-only multi-agent tools, Codex apply-patch, optional web search, long context, and Fast mode |

`plexus-agent-plugins` remains a separate repository because it supports both Pi and Oh My Pi.

## Development

```sh
bun install
bun run check
bun test
```

Run one package directly when needed:

```sh
bun --cwd packages/pi-control test
bun --cwd packages/pi-suppress-providers test
```

For local Pi development, point Pi at a package directory:

```sh
pi -e ./packages/pi-control
pi -e ./packages/pi-suppress-providers
```

## Releases

Each package's `package.json` holds the version that gets published, and it must match the tag:

```text
pi-control-v0.3.3            -> packages/pi-control/package.json
pi-suppress-providers-v0.1.6 -> packages/pi-suppress-providers/package.json
```

Release from a clean `main` with the script:

```sh
scripts/release.sh pi-control 0.3.3
```

It bumps the manifest, runs that package's checks and tests, commits, and pushes both the commit and
the `<package>-v<version>` tag. The tag push triggers `publish-<package>.yml`, which verifies the tag
matches `package.json` and publishes with provenance; a mismatch fails before anything is published.
