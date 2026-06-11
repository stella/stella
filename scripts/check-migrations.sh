#!/usr/bin/env bash
#
# Guard against schema changes landing without migration files.
#
set -euo pipefail

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
  git fetch origin main --depth=1
  BASE_REF="origin/main"
fi

CHANGED_FILES="$(git diff --name-only "$BASE_REF"...HEAD)"

extract_schema_files() {
  local source_file="$1"

  bun -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const sourceFile = process.argv.at(1);
    const source = fs.readFileSync(sourceFile, "utf8");
    const schemaMatch = source.match(/schema\s*:\s*\[([\s\S]*?)\]/m);

    if (!schemaMatch) {
      process.exit(2);
    }

    const schemaFiles = [...schemaMatch[1].matchAll(/["'"'"'`]([^"'"'"'`]+\.ts)["'"'"'`]/g)]
      .map((match) => {
        const schemaPath = match[1];

        if (schemaPath.startsWith(".")) {
          return path.posix.normalize(path.posix.join("apps/api", schemaPath));
        }

        return path.posix.normalize(schemaPath);
      })
      .sort();

    if (schemaFiles.length === 0) {
      process.exit(3);
    }

    console.log(schemaFiles.join("\n"));
  ' "$source_file"
}

SCHEMA_FILES="$(extract_schema_files apps/api/drizzle.config.ts || true)"

if [[ -z "$SCHEMA_FILES" ]]; then
  echo "ERROR: Could not find schema inputs in apps/api/drizzle.config.ts." >&2
  exit 1
fi

BASE_SCHEMA_FILES="$(
  git show "$BASE_REF:apps/api/drizzle.config.ts" 2>/dev/null \
    | extract_schema_files /dev/stdin \
    || true
)"

SCHEMA_CHANGED=false
MIGRATION_CHANGED=false
SCHEMA_INPUTS_CHANGED=false
MIGRATION_SQL_FILES=()

if [[ -n "$BASE_SCHEMA_FILES" && "$BASE_SCHEMA_FILES" != "$SCHEMA_FILES" ]]; then
  SCHEMA_INPUTS_CHANGED=true
fi

is_schema_file() {
  local changed_file="$1"
  local schema_file

  while IFS= read -r schema_file; do
    if [[ "$changed_file" == "$schema_file" ]]; then
      return 0
    fi
  done <<< "$SCHEMA_FILES"

  return 1
}

schema_file_has_migration_relevant_diff() {
  local changed_file="$1"

  # Type-only import ownership changes do not alter the generated DDL.
  bun -e '
    const { spawnSync } = require("node:child_process");
    const fs = require("node:fs");

    const baseRef = process.argv.at(1);
    const changedFile = process.argv.at(2);

    const stripTypeOnlyImports = (source) => {
      const keptLines = [];
      let inTypeImport = false;

      for (const line of source.split("\n")) {
        const startsTypeImport = line.trimStart().startsWith("import type ");
        if (!inTypeImport && startsTypeImport) {
          inTypeImport = !line.includes(";");
          continue;
        }

        if (inTypeImport) {
          inTypeImport = !line.includes(";");
          continue;
        }

        keptLines.push(line);
      }

      return keptLines.join("\n");
    };

    const currentSource = fs.readFileSync(changedFile, "utf8");
    const baseSource = spawnSync("git", ["show", `${baseRef}:${changedFile}`], {
      encoding: "utf8",
    });

    if (baseSource.status !== 0) {
      process.exit(0);
    }

    process.exit(
      stripTypeOnlyImports(currentSource) === stripTypeOnlyImports(baseSource.stdout)
        ? 1
        : 0,
    );
  ' "$BASE_REF" "$changed_file"
}

while IFS= read -r file; do
  if is_schema_file "$file"; then
    if schema_file_has_migration_relevant_diff "$file"; then
      SCHEMA_CHANGED=true
    fi
    continue
  fi

  case "$file" in
    apps/api/drizzle/*)
      MIGRATION_CHANGED=true

      if [[ "$file" == apps/api/drizzle/*.sql && -f "$file" ]]; then
        MIGRATION_SQL_FILES+=("$file")
      fi
      ;;
  esac
done <<< "$CHANGED_FILES"

if [[ "$SCHEMA_INPUTS_CHANGED" == "true" ]]; then
  SCHEMA_CHANGED=true
fi

if [[ "$SCHEMA_CHANGED" == "true" && "$MIGRATION_CHANGED" != "true" ]]; then
  echo "ERROR: Database schema changed without a migration file in apps/api/drizzle/." >&2
  echo "Generate one with: cd apps/api && bun --bun drizzle-kit generate --name <change-name>" >&2
  exit 1
fi

if [[ -d apps/api/drizzle ]]; then
  if [[ "${#MIGRATION_SQL_FILES[@]}" -gt 0 ]]; then
    bun scripts/check-migration-safety.ts "${MIGRATION_SQL_FILES[@]}"

    # Lock-safety linting (rule set configured in .squawk.toml). Destructive
    # changes are covered separately by check-migration-safety.ts above.
    bun squawk "${MIGRATION_SQL_FILES[@]}" || {
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
