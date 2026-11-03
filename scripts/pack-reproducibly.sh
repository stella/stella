#!/usr/bin/env bash
# Build the same source twice; publish only an artifact the rebuild reproduces.
set -euo pipefail

package="${1:?usage: pack-reproducibly.sh <package-directory> <destination>}"
destination="${2:?usage: pack-reproducibly.sh <package-directory> <destination>}"
if [[ ! "$package" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Invalid package directory: $package" >&2
  exit 1
fi
tooling_root="$(cd "$(dirname "$0")/.." && pwd)"
root="${PACK_SOURCE_ROOT:-$tooling_root}"
cd "$root"
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
temporary="$(mktemp -d)"
manifest="packages/$package/package.json"
cp "$manifest" "$temporary/package.json"
cleanup() {
  cp "$temporary/package.json" "$manifest"
  rm -rf "$temporary"
}
trap cleanup EXIT

for pass in first second; do
  cp "$temporary/package.json" "$manifest"
  rm -rf "packages/$package/dist"
  if [[ "$package" == cli ]]; then
    (cd packages/cli && bun run codegen:runtime)
  fi
  (cd "packages/$package" && bun run build)
  bun "$tooling_root/scripts/prepare-publish.ts" "packages/$package"
  mkdir "$temporary/$pass"
  # prepack would rebuild after declaration canonicalization.
  (cd "packages/$package" && bun pm pack --ignore-scripts --destination "$temporary/$pass")
done

first=("$temporary/first/"*.tgz)
second=("$temporary/second/"*.tgz)
if [[ "${#first[@]}" -ne 1 || "${#second[@]}" -ne 1 || ! -f "${first[0]}" || ! -f "${second[0]}" ]]; then
  echo "@stll/$package: each pack must produce exactly one tarball" >&2
  exit 1
fi
if ! cmp -s "${first[0]}" "${second[0]}"; then
  echo "::error::@stll/$package: rebuilding the same source produced different npm tarball bytes" >&2
  exit 1
fi
cp "${first[0]}" "$destination/"
echo "@stll/$package: verified byte-identical rebuilt tarball"
