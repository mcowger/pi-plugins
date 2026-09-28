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

`packages/<package>/package.json` is the source of truth for the version and must match the publish
tag, for example `pi-control-v0.3.3` requires `"version": "0.3.3"`. Release from a clean `main`
with the script, which bumps the manifest, runs the package checks, commits, tags, and pushes both
refs:

```sh
scripts/release.sh pi-control 0.3.3
```

The matching `publish-<package>.yml` workflow verifies the tag and manifest agree, and fails before
publishing if they do not. Push the tag by name when doing it by hand: `git push --follow-tags`
skips these lightweight tags. Only packages with a `publish-<package>.yml` workflow are releasable.

## Package layout

- `packages/pi-control`: action-based tool-call policy extension and skills.
- `packages/pi-suppress-providers`: provider visibility extension.
