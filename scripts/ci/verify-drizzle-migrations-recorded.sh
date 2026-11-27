#!/usr/bin/env bash
set -euo pipefail
EXPECTED=$(find apps/api/drizzle -mindepth 1 -maxdepth 1 -type d -name '20*' | wc -l | tr -d ' ')
APPLIED=$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc "SELECT count(*) FROM drizzle.__drizzle_migrations")
echo "Expected $EXPECTED migrations, drizzle.__drizzle_migrations has $APPLIED"
[ "$EXPECTED" = "$APPLIED" ] || {
  echo "::error::Migration count mismatch: $APPLIED applied, $EXPECTED on disk."
  exit 1
}
