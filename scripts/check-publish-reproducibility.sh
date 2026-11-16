#!/usr/bin/env bash
# The census shares publish-npm.yml's package inventory, never a second list.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
destination="$(mktemp -d)"
trap 'rm -rf "$destination"' EXIT
packages="$(bun -e 'import { ALL_PACKAGE_ORDER } from "./scripts/publish-packages.ts"; console.log(ALL_PACKAGE_ORDER.join("\n"))')"
while IFS= read -r package; do
  bash scripts/pack-reproducibly.sh "$package" "$destination/$package"
done <<< "$packages"
