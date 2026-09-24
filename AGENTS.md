# Pi plugins

This repository contains independent Pi packages in `packages/`.

## Commands

```sh
bun install
bun run check
bun test
```

Use `bun --cwd packages/<package> ...` to work on one package. Package manifests keep the
published npm names and Pi extension manifests. The root workspace is private and is not itself a
Pi package.

Cora reviews must never be run automatically. Run them only when explicitly requested by the user.

## Releases

Publish tags use the package name and version, for example `pi-control-v0.3.3`. The root publish
workflow selects the package from the tag and publishes only that package.

## Package layout

- `packages/pi-control`: action-based tool-call policy extension and skills.
- `packages/pi-suppress-providers`: provider visibility extension.
- `packages/super-agents-pi`: in-process user-defined sub-agents extension.
