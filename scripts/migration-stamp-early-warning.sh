#!/usr/bin/env bash
#
# Fails when a migration the branch adds is stamped at or before the newest
# migration on the target branch. database-migrations-check compares against
# the target branch when the run starts, so a migration that main overtakes
# afterwards passes the pull request and fails only in the merge group. This
# reports it while the branch can still be re-stamped, with the command that
# does it. It needs only git, so it runs without an install.
#
# Usage: bash scripts/migration-stamp-early-warning.sh <base-ref> [<head-ref>]
set -euo pipefail

usage="Usage: bash scripts/migration-stamp-early-warning.sh <base-ref> [<head-ref>]"
base_ref="${1:?$usage}"
head_ref="${2:-HEAD}"
migrations=apps/api/drizzle

merge_base="$(git merge-base "$base_ref" "$head_ref")"

# A migration's identity is its folder name; its stamp is the leading 14 digits.
newest_base="$(git ls-tree --name-only "$base_ref" -- "$migrations/" |
  sed -n 's|^apps/api/drizzle/\([0-9]\{14\}_[^/]\{1,\}\)$|\1|p' |
  LC_ALL=C sort | tail -n 1)"
if [[ -z "$newest_base" ]]; then
  echo "No stamped migrations on $base_ref."
  exit 0
fi
newest_stamp="${newest_base:0:14}"

added="$(git diff --no-renames --name-only --diff-filter=A "$merge_base" "$head_ref" -- "$migrations" |
  sed -n 's|^apps/api/drizzle/\([0-9]\{14\}_[^/]\{1,\}\)/migration\.sql$|\1|p' |
  LC_ALL=C sort)"

stale=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if (( 10#${name:0:14} <= 10#$newest_stamp )); then
    stale+=("$name")
  fi
done <<< "$added"

if (( ${#stale[@]} == 0 )); then
  echo "Every added migration follows $newest_base on $base_ref."
  exit 0
fi

# The fix is MIGRATION_RESTAMP_COMMAND in scripts/migration-stamps.ts; the
# test checks that both say the same. It is printed, never run.
for name in "${stale[@]}"; do
  echo "::error title=Migration stamp behind main::$migrations/$name must be stamped later than $migrations/$newest_base on $base_ref; the merge queue refuses it. Fix: git fetch origin main && bun scripts/migration-restamp.ts --write --base origin/main --update-tests"
done
report="$(
  echo "### Migration stamps behind $base_ref"
  echo
  echo "The newest migration on $base_ref is \`$newest_base\`. These migrations sort before it, so database-migrations-check fails them in the merge group:"
  echo
  for name in "${stale[@]}"; do
    echo "- \`$migrations/$name\`"
  done
  echo
  echo "Re-stamp them (this moves their lock allowances and rewrites the references in the generated files and API tests), then commit the moved files and push:"
  echo
  echo '```sh'
  echo "git fetch origin main && bun scripts/migration-restamp.ts --write --base origin/main --update-tests"
  echo '```'
  echo
  echo "Add \`--forward <hours>\` to stamp them that many hours ahead, so migrations that merge in the meantime do not overtake them again."
)"
echo "$report"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$report" >> "$GITHUB_STEP_SUMMARY"
fi
exit 1
