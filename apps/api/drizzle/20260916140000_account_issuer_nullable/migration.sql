SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Better Auth 1.7.3 retracted the `issuer` column it introduced in 1.7.0 and
-- stopped writing it, so a NOT NULL column with no default rejects every
-- sign-up and account link once the library is bumped. Relax the column here,
-- one release ahead of that bump.
--
-- Safe before and after the bump: the library pinned in this release is still
-- 1.7.1 and keeps writing `issuer` on every insert, and a nullable column
-- accepts that value unchanged. So both writers are valid against this shape.
-- The 1.7.4 bump depends on this migration being live in production; this
-- migration depends on nothing from it.
--
-- DROP NOT NULL is catalog-only: it rewrites no rows but takes a brief ACCESS
-- EXCLUSIVE lock on `account`. The 2s lock_timeout above makes it fail fast
-- and leave the release retryable rather than queue behind a long-running
-- reader while every new session insert piles up behind it. Re-running is a
-- no-op once the column is already nullable.
ALTER TABLE "account"
  ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint

-- The identity guarantee moves to (provider_id, account_id), the pair Better
-- Auth links accounts by, so uniqueness survives `issuer` becoming optional.
-- Built CONCURRENTLY so sign-in never write-locks `account`; Drizzle wraps
-- pending migrations in one transaction and CREATE INDEX CONCURRENTLY must run
-- outside one, so COMMIT, build, then BEGIN again for the migrator's
-- bookkeeping row (same split as 20260913220000_legislation_document_slugs).
--
-- The legacy (issuer, account_id) index is NOT dropped here. Retiring it is
-- owned by ONLINE_INDEX_REPLACEMENTS in src/db/online-migrations.ts, which
-- proves this replacement is ready first, so no window exists in which neither
-- index enforces uniqueness.
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "account_provider_account_id_uidx"
  ON "account" ("provider_id", "account_id");--> statement-breakpoint
-- An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS
-- would otherwise accept on retry, and an INVALID unique index enforces
-- nothing. Reindexing is the online validity repair.
REINDEX INDEX CONCURRENTLY "account_provider_account_id_uidx";--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
