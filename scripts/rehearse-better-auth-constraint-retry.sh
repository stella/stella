#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 || "$1" != "--local-test-database" ]]; then
  echo "usage: $0 --local-test-database" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
readonly repo_root
readonly constraints_migration="20260825220000_better_auth_17_constraints"
readonly constraints_sql="$repo_root/apps/api/drizzle/$constraints_migration/migration.sql"
readonly account_key_migration="20260912100000_better_auth_173_account_key"
readonly account_key_sql="$repo_root/apps/api/drizzle/$account_key_migration/migration.sql"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [[ ! "$DATABASE_URL" =~ @127\.0\.0\.1:[0-9]+/ ]]; then
  echo "The constraint retry rehearsal requires a loopback Postgres URL" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  constraints_hash="$(sha256sum "$constraints_sql" | awk '{ print $1 }')"
  account_key_hash="$(sha256sum "$account_key_sql" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  constraints_hash="$(shasum -a 256 "$constraints_sql" | awk '{ print $1 }')"
  account_key_hash="$(shasum -a 256 "$account_key_sql" | awk '{ print $1 }')"
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi
readonly constraints_hash
readonly account_key_hash

recorded_constraints="$(
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At \
    -v constraints_migration="$constraints_migration" \
    -v constraints_hash="$constraints_hash" \
    -v account_key_migration="$account_key_migration" \
    -v account_key_hash="$account_key_hash" <<'SQL'
SELECT count(*) FROM drizzle.__drizzle_migrations
WHERE (name = :'constraints_migration' AND hash = :'constraints_hash')
   OR (name = :'account_key_migration' AND hash = :'account_key_hash');
SQL
)"
if [[ "$recorded_constraints" -ne 2 ]]; then
  echo "Expected matching Better Auth constraints and account-key migration receipts" >&2
  exit 1
fi

recorded_before="$(
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
    'SELECT count(*) FROM drizzle.__drizzle_migrations'
)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v constraints_migration="$constraints_migration" \
  -v constraints_hash="$constraints_hash" \
  -v account_key_migration="$account_key_migration" \
  -v account_key_hash="$account_key_hash" <<'SQL' >/dev/null
BEGIN;
DROP INDEX IF EXISTS "account_issuer_account_id_uidx";
ALTER TABLE "account"
  ALTER COLUMN "issuer" DROP NOT NULL;
INSERT INTO "user" ("id", "name", "email")
VALUES ('constraint-retry-user', 'Constraint Retry', 'constraint-retry@example.invalid');
INSERT INTO "account" (
  "id", "account_id", "provider_id", "user_id", "issuer", "updated_at"
)
VALUES (
  'constraint-retry-account', 'constraint-retry', 'google',
  'constraint-retry-user', NULL, now()
);
DELETE FROM drizzle.__drizzle_migrations
WHERE (name = :'constraints_migration' AND hash = :'constraints_hash')
   OR (name = :'account_key_migration' AND hash = :'account_key_hash');
COMMIT;
SQL

failure_log="$(mktemp)"
readonly failure_log
trap 'rm -f "$failure_log"' EXIT
if (
  cd "$repo_root/apps/api"
  bun run src/db/migrate.ts
) >"$failure_log" 2>&1; then
  echo "Constraints migration accepted an incomplete issuer backfill" >&2
  exit 1
fi

if ! grep -Fq 'account_issuer_not_null_check' "$failure_log"; then
  echo "Constraints migration failed for an unrelated reason" >&2
  tail -40 "$failure_log" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
SELECT
  NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.account'::regclass
      AND conname = 'account_issuer_not_null_check'
  )
  AND to_regclass('public.account_issuer_account_id_uidx') IS NULL;
" | grep -qx t || {
  echo "Incomplete backfill left committed constraint side effects" >&2
  exit 1
}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DELETE FROM "account" WHERE "id" = 'constraint-retry-account';
DELETE FROM "user" WHERE "id" = 'constraint-retry-user';
SQL

(
  cd "$repo_root/apps/api"
  bun run src/db/migrate.ts
)

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v constraints_migration="$constraints_migration" \
  -v constraints_hash="$constraints_hash" \
  -v account_key_migration="$account_key_migration" \
  -v account_key_hash="$account_key_hash" <<'SQL' >/dev/null
BEGIN;
ALTER TABLE "account"
  ALTER COLUMN "issuer" DROP NOT NULL;
ALTER TABLE "account"
  ADD CONSTRAINT "account_issuer_not_null_check"
  CHECK ("issuer" IS NOT NULL) NOT VALID;
DELETE FROM drizzle.__drizzle_migrations
WHERE (name = :'constraints_migration' AND hash = :'constraints_hash')
   OR (name = :'account_key_migration' AND hash = :'account_key_hash');
COMMIT;
SQL

recorded_interrupted="$(
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
    'SELECT count(*) FROM drizzle.__drizzle_migrations'
)"
if [[ "$recorded_interrupted" -ne $((recorded_before - 2)) ]]; then
  echo "Interrupted rehearsal did not remove exactly two migration receipts" >&2
  exit 1
fi

(
  cd "$repo_root/apps/api"
  bun run src/db/migrate.ts
)

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
SELECT
  (SELECT count(*) = ${recorded_before}
   FROM drizzle.__drizzle_migrations)
  AND NOT (SELECT attnotnull
       FROM pg_attribute
       WHERE attrelid = 'public.account'::regclass
         AND attname = 'issuer')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.account'::regclass
      AND conname = 'account_issuer_not_null_check'
  )
  AND to_regclass('public.account_issuer_account_id_uidx') IS NULL;
" | grep -qx t || {
  echo "Retried Better Auth constraints migration did not converge" >&2
  exit 1
}

echo "Better Auth account migrations converged after interrupted receipts"
