#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
repo=stella/stella
asset=mcp-surface.json
# Desktop publication controls GitHub's latest pointer. Application releases
# may already be published while that pointer still names the previous build.
bash scripts/gh-retry.sh api "repos/$repo/git/matching-refs/tags/v" --paginate |
  jq -sr '[.[][] | .ref | sub("^refs/tags/"; "") | select(test("^v[0-9]+[.][0-9]+[.][0-9]+$"))] | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | reverse[]' > "$scratch/tags"
published=false
while IFS= read -r tag; do
  : > "$scratch/status"
  if GH_RETRY_STATUS_FILE="$scratch/status" bash scripts/gh-retry.sh api "repos/$repo/releases/tags/$tag" \
    --jq '{draft, prerelease, assets: [.assets[].name]}' > "$scratch/release.json"; then
    jq -e '(.draft | type) == "boolean" and (.prerelease | type) == "boolean" and (.assets | type) == "array"' "$scratch/release.json" >/dev/null
    if jq -e '.draft == false and .prerelease == false' "$scratch/release.json" >/dev/null; then
      published=true
      break
    fi
  elif [[ "$(cut -d ' ' -f 1 "$scratch/status")" != 404 ]]; then
    exit 1
  fi
done < "$scratch/tags"
if [[ "$published" != true ]]; then
  echo "No published stable application release in $repo" >&2
  exit 1
fi
if jq -e --arg asset "$asset" '.assets | index($asset) != null' "$scratch/release.json" >/dev/null; then
  bash scripts/gh-retry.sh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$scratch"
else
  echo "Deriving the previous MCP surface from $tag (release predates the asset)." >&2
  mkdir "$scratch/source"
  git archive "refs/tags/$tag" | tar -x -C "$scratch/source"
  bash scripts/export-release-mcp-surface.sh "$scratch/source" "$scratch/$asset"
fi

unset GH_TOKEN GITHUB_TOKEN
bun --cwd=apps/api run generate:capability-runtime
bun --cwd=apps/api --env-file=.env.example scripts/export-mcp-surface.ts "$scratch/current.json"
echo "Comparing the current MCP surface with $tag."
bun scripts/check-mcp-surface-compat.ts "$scratch/$asset" "$scratch/current.json" "$tag"
