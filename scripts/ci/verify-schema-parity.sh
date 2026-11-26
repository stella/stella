#!/usr/bin/env bash
set -eo pipefail
OUT=$(bun --bun drizzle-kit push --explain 2>&1)
echo "$OUT"
grep -q "No changes detected" <<<"$OUT" || {
  echo "::error::Migrated schema does not match schema.ts. Either commit a generated migration that closes the gap, or fix the migration files."
  exit 1
}
