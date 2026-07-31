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
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_document_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "case_law_decisions_source_document_idx"
  ON "case_law_decisions" ("source_id","source_document_id")
  WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_case_lang_null_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "case_law_decisions_source_case_lang_null_idx"
  ON "case_law_decisions" ("source_id","case_number","language")
  WHERE "source_document_id" IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_case_lang_idx";
--> statement-breakpoint
BEGIN;
