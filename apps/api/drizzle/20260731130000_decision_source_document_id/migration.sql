-- stella-migration-safety: reviewed destructive-change - drops indexes only, no
-- table or column data. Two of the three drops are the idempotency guard the
-- CONCURRENTLY pattern requires (an interrupted build leaves an INVALID index
-- that a later CREATE IF NOT EXISTS would skip), so they are no-ops on a clean
-- run. The third drops the old case-number unique index only after its partial
-- replacement has been built, so uniqueness is enforced throughout. Rollback is
-- to recreate that index CONCURRENTLY over the same columns without the
-- predicate; no data is lost either way.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- What identifies a decision is the id its publisher gives it. A case
-- number cannot: courts number dockets per court, so a source covering
-- many courts issues the same number many times over, and keying on it
-- makes two unrelated decisions the same row.
--
-- Identity becomes two halves that together cover every row exactly once:
-- the publisher's id where the source states one, the case number where it
-- does not (sound for a source holding a single court).
--
-- Values are not backfilled here. The table holds millions of rows, which
-- is more than one in-transaction UPDATE can finish within
-- statement_timeout; src/scripts/backfill-source-document-ids.ts fills them
-- in batches. Until a row is filled it stays NULL and keeps the case-number
-- key, so the pair of partial indexes is valid at every point in between.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "source_document_id" varchar(256);--> statement-breakpoint

-- Both indexes are built CONCURRENTLY so neither write-locks a table this
-- size. Drizzle wraps pending migrations in one transaction and CREATE
-- INDEX CONCURRENTLY cannot run inside one, so COMMIT here and reopen with
-- BEGIN for the migration bookkeeping row (same split as
-- 20260603120000_case_law_public_slugs).
--
-- An interrupted CONCURRENTLY build leaves an INVALID index under the same
-- name, and a `CREATE ... IF NOT EXISTS` retry would skip it and record the
-- migration as applied with uniqueness silently unenforced. Drop first
-- (no-op on a clean run), then build without IF NOT EXISTS.
--
-- Order matters: the replacement for the old key is built before the old
-- one is dropped, so uniqueness is enforced continuously rather than
-- leaving a window in which duplicates could land.
SET statement_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting -- deliberate: CREATE INDEX CONCURRENTLY cannot run inside the migrator's transaction, so it is closed here and reopened below
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_document_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would skip an INVALID index left by an interrupted CONCURRENTLY build; the preceding DROP is what makes a retry robust
CREATE UNIQUE INDEX CONCURRENTLY "case_law_decisions_source_document_idx"
  ON "case_law_decisions" ("source_id","source_document_id")
  WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_case_lang_null_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- see the note on the index above
CREATE UNIQUE INDEX CONCURRENTLY "case_law_decisions_source_case_lang_null_idx"
  ON "case_law_decisions" ("source_id","case_number","language")
  WHERE "source_document_id" IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_case_lang_idx";
--> statement-breakpoint
-- squawk-ignore ban-uncommitted-transaction, transaction-nesting -- reopens the migrator's own transaction, closed above so the concurrent builds could run outside it; Drizzle commits it after writing its bookkeeping row
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
