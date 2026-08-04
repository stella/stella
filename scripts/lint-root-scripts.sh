#!/usr/bin/env bash
# Lint root `scripts/` with the full Oxlint ruleset.
#
# `turbo run lint` only reaches workspaces and `code-check-affected.ts` only
# lints affected workspace targets, so root `scripts/` — which holds the repo's
# own CI guards (ratchet, rc-bailouts, typecheck-baseline, lint-changed) — sits
# outside every target. This closes that gap.
#
# The file list is enumerated from git rather than passed as the `scripts`
# directory: a directory target silently matches zero files in a linked
# worktree (Oxlint's ignore walker excludes it) and exits 0, which reads as a
# pass. An explicit list fails loudly instead.
#
# This run subsumes the former SQL-only guard: `no-bare-jsonb-cast` is "error"
# in the base config, so a repair or backfill script writing JSONB through a
# bare `::jsonb` cast (which double-encodes the value Postgres stores) is still
# caught here.
set -euo pipefail

files=()
while IFS= read -r file; do
  files+=("${file}")
done < <(git ls-files 'scripts/*.ts' 'scripts/**/*.ts')

if [[ ${#files[@]} -eq 0 ]]; then
  echo "lint-root-scripts: no script files found; refusing to pass vacuously" >&2
  exit 1
fi

exec bun --bun oxlint -c oxlint.config.ts \
  --report-unused-disable-directives-severity=error \
  --deny-warnings \
  --type-aware \
  --type-check \
  "${files[@]}"
