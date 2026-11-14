#!/usr/bin/env bash
#
# Guard against schema changes landing without migration files.
#
set -euo pipefail
# Resolved without dirname: callers may run this with only bash and git.
script_dir="${BASH_SOURCE[0]%/*}"
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then
  script_dir=.
fi
retry_script="$script_dir/retry.sh"

BASE_REF="${BASE_REF:-}"

if [[ -z "$BASE_REF" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    BASE_REF="origin/${GITHUB_BASE_REF}"
  else
    BASE_REF="HEAD^"
  fi
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "Base ref '$BASE_REF' is not available; fetching origin/main."
  "$BASH" "$retry_script" git fetch origin main --depth=1
  BASE_REF="origin/main"
fi

CHANGED_FILES="$(git diff --name-only "$BASE_REF"...HEAD)"

# The folder name identifies a migration in the deployed ledger. Reject
# deletion or renaming of a migration already present at the merge base.
bun scripts/check-migration-order.ts "$BASE_REF"
bun scripts/check-migration-locks.ts --base "$BASE_REF"

MIGRATION_SQL_FILES=()

while IFS= read -r file; do
  case "$file" in
    apps/api/drizzle/*)
      if [[ "$file" == apps/api/drizzle/*.sql && -f "$file" ]]; then
        MIGRATION_SQL_FILES+=("$file")
      fi
      ;;
  esac
done <<< "$CHANGED_FILES"

bun scripts/check-migration-schema.ts "$BASE_REF"

# Grandfather already-applied migrations: lint only files NOT in the baseline.
# Existing migrations are immutable — Drizzle tracks them by content hash, so
# editing one to satisfy a new lint rule changes its hash and breaks the
# migrator on live databases. The baseline (scripts/migration-baseline.txt) exempts
# those; every NEW migration (not listed) is still fully linted.
BASELINE_FILE="scripts/migration-baseline.txt"

# The baseline only shrinks, except that a change introducing a
# migration-safety rule may add merged, unchanged migrations the new rule flags.
bun scripts/check-migration-baseline.ts "$BASE_REF"

LINT_SQL_FILES=()
for migration_file in "${MIGRATION_SQL_FILES[@]+"${MIGRATION_SQL_FILES[@]}"}"; do
  if [[ -f "$BASELINE_FILE" ]] && grep -qxF "$migration_file" "$BASELINE_FILE"; then
    continue
  fi
  LINT_SQL_FILES+=("$migration_file")
done

if [[ -d apps/api/drizzle ]]; then
  if [[ "${#LINT_SQL_FILES[@]}" -gt 0 ]]; then
    bun scripts/check-migration-safety.ts "${LINT_SQL_FILES[@]}"

    # Lock-safety linting (rule set configured in .squawk.toml). Destructive
    # changes are covered separately by check-migration-safety.ts above.
    bun squawk "${LINT_SQL_FILES[@]}" || {
      echo "ERROR: squawk found DDL in the changed migrations that is unsafe to apply under load." >&2
      echo "Rewrite the statement (rule docs: https://squawkhq.com/docs/rules), or suppress a" >&2
      echo "reviewed finding with '-- squawk-ignore <rule-name>' on the line above the statement." >&2
      exit 1
    }
  fi

  (cd apps/api && bun --bun drizzle-kit check)
else
  echo "No apps/api/drizzle directory yet; migration consistency check skipped."
fi
