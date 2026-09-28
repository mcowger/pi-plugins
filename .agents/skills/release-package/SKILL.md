---
name: release-package
description: Release a package in the pi-plugins monorepo to npm. Use when bumping a package version, creating or pushing a pi-control-v or pi-suppress-providers-v tag, publishing a package, or when the user asks to release, cut a release, tag a version, or ship a new version of a package.
---

# Release a package

`packages/<package>/package.json` is the source of truth for the version. The publish tag must match
it exactly, and `.github/workflows/publish-<package>.yml` fails before publishing if the two
disagree. The workflow verifies, it never rewrites the manifest.

## Run the script

From a clean `main` at the repo root:

```sh
scripts/release.sh <package> <version>
```

It bumps the manifest, runs that package's checks and tests, commits `chore: release <package>
<version>`, creates the tag `<package>-v<version>`, and pushes the commit and the tag. The tag push
triggers the publish workflow.

```sh
scripts/release.sh pi-control 0.6.2
```

The script refuses to run when the tree is dirty, the branch is not `main`, the tag exists, the
manifest is already at that version, or the version is already on npm.

## Rules that matter

- **Push the tag by name.** `git push --follow-tags` does not push lightweight tags, which these
  are. The tag then stays local, no workflow runs, and the release looks successful while nothing
  was published. The script pushes the tag explicitly for this reason.
- **Release from `main`.** A tag on an unmerged branch publishes a version whose manifest bump is
  missing from `main`, which recreates the drift this setup exists to prevent.
- **Only packages with a `publish-<package>.yml` workflow are releasable.** `pi-microgpt` has none,
  so it cannot be released; do not add a version bump for it.
- **Never edit the version in CI.** If someone tags without bumping, the run fails at the verify
  step. Fix it by bumping, committing, then re-tagging — do not weaken the check.
- Published versions are immutable, so pick a version that is not on npm yet.

## After pushing

Confirm the run, then confirm the registry:

```sh
gh run list --workflow publish-<package>.yml --limit 1
npm view <package-name> dist-tags version
```

A new publish takes roughly two minutes to appear on the registry: npm reports "Your package is
being processed", the `latest` dist-tag flips first, and the version appears in the packument
shortly after. Do not treat that delay as a failure.
