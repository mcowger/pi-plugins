#!/usr/bin/env bash
#
# Release one package from this monorepo to npm.
#
#   scripts/release.sh <package> <version>
#
# Bumps the package manifest, runs that package's checks and tests, commits, tags, and pushes
# both the commit and the tag. The tag push is what triggers .github/workflows/publish-<package>.yml,
# which re-verifies the tag against the manifest before publishing.
#
# The manifest version is the source of truth: package.json must carry the version being released,
# and the publish workflow fails if the tag and the manifest disagree.
set -euo pipefail

die() {
	printf 'release: %s\n' "$*" >&2
	exit 1
}

[ $# -eq 2 ] || die "usage: $(basename "$0") <package> <version>"

package="$1"
version="$2"

cd "$(git rev-parse --show-toplevel)"

package_dir="packages/$package"
[ -d "$package_dir" ] || die "no such package: $package_dir"

workflow=".github/workflows/publish-$package.yml"
[ -f "$workflow" ] || die "$package is not publishable: $workflow does not exist"

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' ||
	die "'$version' is not a semver version"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "releases come from main, not '$branch'"

tag="$package-v$version"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

name="$(node -p "require('./$package_dir/package.json').name")"
current="$(node -p "require('./$package_dir/package.json').version")"
[ "$current" != "$version" ] || die "$package_dir/package.json is already at $version"

npm view "$name@$version" version >/dev/null 2>&1 &&
	die "$name@$version is already published; pick a new version"

printf 'release: %s %s -> %s\n' "$name" "$current" "$version"

# Rewrite only the version value: `npm pkg set` also reorders devDependencies, which would add
# unrelated churn to the release commit.
VERSION="$version" MANIFEST="$package_dir/package.json" node -e '
const fs = require("node:fs");
const file = process.env.MANIFEST;
const before = fs.readFileSync(file, "utf8");
const after = before.replace(/("version"\s*:\s*")[^"]*(")/, `$1${process.env.VERSION}$2`);
if (after === before) {
	console.error(`release: no version field found in ${file}`);
	process.exit(1);
}
fs.writeFileSync(file, after);
'

(cd "$package_dir" && bun run check && bun test)

git add "$package_dir/package.json"
git commit -m "chore: release $package $version"

git tag "$tag"
git push origin "$branch"
# Push the tag by name: `git push --follow-tags` skips lightweight tags, which these are.
git push origin "$tag"

printf 'release: pushed %s; the publish workflow is now running\n' "$tag"
