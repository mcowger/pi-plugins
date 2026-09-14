#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$repo_root"
mise trust "$repo_root/mise.toml"
mise install bun actionlint
bun install
