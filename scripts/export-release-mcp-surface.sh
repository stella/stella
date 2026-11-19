#!/usr/bin/env bash
set -euo pipefail

# Called on a disposable checkout of the release SHA, using its lockfile,
# runtime registry, generated capabilities and wire serializer.
tooling="$(cd "$(dirname "$0")/.." && pwd)"
cd "${1:?release source directory required}"
output="${2:?absolute output path required}"
if [[ ! -f apps/api/scripts/export-mcp-surface.ts ]]; then
  cp "$tooling/apps/api/scripts/export-mcp-surface.ts" apps/api/scripts/
fi
unset CI_GENERATED_SOURCES_MANIFEST GH_TOKEN GITHUB_TOKEN
bash "$tooling/scripts/retry.sh" bun ci --ignore-scripts
bun --cwd=apps/api run generate:capability-runtime
bun --cwd=apps/api --env-file=.env.example scripts/export-mcp-surface.ts "$output"
