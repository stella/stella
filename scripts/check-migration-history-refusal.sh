#!/usr/bin/env bash
# CI rehearsal: corrupt the newest applied migration hash, then prove the
# migrator takes the approved no-op path with no pending SQL and refuses
# before running pending SQL; restore the hash and migrate cleanly.
set -euo pipefail
psql -h 127.0.0.1 -U stella_owner -d stella -c \
  "CREATE TABLE drizzle.__migration_history_smoke_backup AS SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1" \
  >/dev/null
backup_count=$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc \
  "SELECT count(*) FROM drizzle.__migration_history_smoke_backup")
if [[ "$backup_count" != "1" ]]; then
  echo "::error::Backed up $backup_count migration rows; expected 1."
  exit 1
fi
corrupted=$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc \
  "WITH corrupted AS (UPDATE drizzle.__drizzle_migrations AS migration SET hash = repeat('0', 64) FROM drizzle.__migration_history_smoke_backup AS backup WHERE migration.id = backup.id RETURNING 1) SELECT count(*) FROM corrupted")
if [[ "$corrupted" != "1" ]]; then
  echo "::error::Corrupted $corrupted migration rows; expected 1."
  exit 1
fi

migration_exit=0
migration_output=$(cd apps/api && bun run src/db/migrate.ts 2>&1) || migration_exit=$?
echo "$migration_output"
if [[ "$migration_exit" != "0" || "$migration_output" != *'"event":"migrate.stale_bundle_noop"'* ]]; then
  echo "::error::A hash mismatch with no pending SQL did not take the approved no-op path."
  exit 1
fi

# The bundle now has pending SQL, so the same mismatch must refuse
# before that SQL creates its marker table.
probe_folder=apps/api/drizzle/20991231235959_ci_history_probe
if [[ -e "$probe_folder" ]]; then
  echo "::error::Migration history probe folder already exists."
  exit 1
fi
mkdir "$probe_folder"
trap 'rm -rf "$probe_folder"' EXIT
printf '%s\n' 'CREATE TABLE public.__migration_history_smoke_probe (id integer PRIMARY KEY);' >"$probe_folder/migration.sql"
if [[ -n "$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc "SELECT to_regclass('public.__migration_history_smoke_probe')")" ]]; then
  echo "::error::Migration history probe table already exists."
  exit 1
fi

migration_exit=0
migration_output=$(cd apps/api && bun run src/db/migrate.ts 2>&1) || migration_exit=$?
echo "$migration_output"
if [[ "$migration_exit" == "0" || "$migration_output" != *'"event":"migrate.stale_bundle_refused"'* ]]; then
  echo "::error::Migration command did not refuse inconsistent history with pending SQL."
  exit 1
fi
if [[ -n "$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc "SELECT to_regclass('public.__migration_history_smoke_probe')")" ]]; then
  echo "::error::Migration SQL ran before the history preflight."
  exit 1
fi
rm -r "$probe_folder"

restored=$(psql -h 127.0.0.1 -U stella_owner -d stella -tAc \
  "WITH restored AS (UPDATE drizzle.__drizzle_migrations AS migration SET hash = backup.hash FROM drizzle.__migration_history_smoke_backup AS backup WHERE migration.id = backup.id AND migration.hash = repeat('0', 64) RETURNING 1) SELECT count(*) FROM restored")
if [[ "$restored" != "1" ]]; then
  echo "::error::Restored $restored migration rows; expected 1."
  exit 1
fi
psql -h 127.0.0.1 -U stella_owner -d stella -c \
  "DROP TABLE drizzle.__migration_history_smoke_backup" \
  >/dev/null
(cd apps/api && bun run src/db/migrate.ts)
