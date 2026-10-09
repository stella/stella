#!/usr/bin/env bash
set -euo pipefail

# Registry copies retain every platform in upstream manifest lists.
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output=${1:?Usage: mirror-ci-service-images.sh <output-directory>}
mkdir -p "$output"
# Validate before publishing anything; avoid process substitution hiding failure.
bun "$repo/scripts/ci-service-images.ts" --list > "$output/sources.tsv"
printf 'source\treference\n' > "$output/digests.tsv"
while IFS=$'\t' read -r source name; do
  tagged=${source%@*}
  tag=${tagged##*:}
  target="ghcr.io/stella/ci-mirror/$name:$tag"
  source_digest=$(crane digest "$source")
  if [[ ! "$source_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'Invalid source digest for %s: %s\n' "$source" "$source_digest" >&2
    exit 1
  fi
  if [[ "$source_digest" != "${source##*@}" ]]; then
    printf 'Source digest differs from inventory for %s\n' "$source" >&2
    exit 1
  fi
  # Resolve the pinned human tag once, then copy that immutable manifest.
  crane copy --jobs 2 "$source" "$target"
  digest=$(crane digest "$target")
  if [[ "$digest" != "$source_digest" ]]; then
    printf 'Target digest differs from source for %s\n' "$target" >&2
    exit 1
  fi
  printf '%s\t%s\n' "$source" "${target%:*}@$digest" >> "$output/digests.tsv"
done < "$output/sources.tsv"
{
  printf '### CI service image digests\n\n'
  printf '| Upstream tag | GHCR reference |\n| --- | --- |\n'
  while IFS=$'\t' read -r source reference; do
    [[ "$source" == source ]] && continue
    printf '| `%s` | `%s` |\n' "$source" "$reference"
  done < "$output/digests.tsv"
} >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
