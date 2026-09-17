-- Reversal for drizzle/20260916140000_account_issuer_nullable.
--
-- It lives beside the operational scripts, not under `drizzle/`: everything
-- there must be a migration directory, because the migrator and the PGlite
-- test bootstrap both read `<dir>/migration.sql` from every entry. Nothing
-- runs this file automatically.
--
-- docs/releases.md keeps database change forward-only, and application
-- rollback does not need this file: the 1.7.1 library still writes `issuer`,
-- so the nullable column serves the old and the new writer alike. This exists
-- for one case only, abandoning the Better Auth 1.7.4 bump and wanting the old
-- constraint back before any row has a NULL issuer.
--
-- Run with `psql -v ON_ERROR_STOP=1 -f <this file>` and NOT inside a
-- transaction: CREATE/DROP INDEX CONCURRENTLY cannot run in one.
--
-- It refuses once a single NULL exists. That is the real expiry: the first
-- sign-up or account link on the bumped library writes one, and from then on
-- re-promoting NOT NULL would reject every subsequent insert.

SET lock_timeout = '2s';
SET statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account" WHERE "issuer" IS NULL) THEN
    RAISE EXCEPTION
      'account_issuer_rollback: a NULL issuer exists; the library has already stopped writing it, so this rollback is expired';
  END IF;
END
$$;

-- Restore the legacy identity key before relaxing the replacement, so one
-- unique index covers `account` at every point.
SET statement_timeout = 0;
SET lock_timeout = 0;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "account_issuer_account_id_uidx"
  ON "account" ("issuer", "account_id");
REINDEX INDEX CONCURRENTLY "account_issuer_account_id_uidx";

SET lock_timeout = '2s';
SET statement_timeout = '30s';

-- The same validated-CHECK promotion 20260825220000_better_auth_17_constraints
-- used: a NOT VALID check plus VALIDATE lets PostgreSQL record NOT NULL
-- without a second table scan under an ACCESS EXCLUSIVE lock.
-- stella-migration-safety: reviewed drop-constraint - Retry cleanup removes
-- only this script's own temporary validation proof, recreated immediately
-- below.
ALTER TABLE "account"
  DROP CONSTRAINT IF EXISTS "account_issuer_not_null_check";
ALTER TABLE "account"
  ADD CONSTRAINT "account_issuer_not_null_check"
  CHECK ("issuer" IS NOT NULL) NOT VALID;
ALTER TABLE "account"
  VALIDATE CONSTRAINT "account_issuer_not_null_check";
ALTER TABLE "account"
  ALTER COLUMN "issuer" SET NOT NULL;
-- stella-migration-safety: reviewed drop-constraint - Removes only the
-- temporary validation proof once equivalent NOT NULL metadata is recorded.
ALTER TABLE "account"
  DROP CONSTRAINT "account_issuer_not_null_check";

-- Last, so no window leaves `account` without a unique identity index.
-- stella-migration-safety: reviewed drop-object - Drops the index this
-- rollback supersedes, after the legacy index is valid and enforcing again.
SET statement_timeout = 0;
SET lock_timeout = 0;
DROP INDEX CONCURRENTLY IF EXISTS "account_provider_account_id_uidx";
