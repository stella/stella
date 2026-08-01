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
-- The migration runner validates both replacement indexes after the ledger
-- update and concurrently repairs interrupted INVALID builds. IF NOT EXISTS
-- preserves an already-valid uniqueness boundary across retries.
--
-- The online migration runner retires the old key only after catalog checks
-- prove that both replacements are valid and ready. This keeps uniqueness
-- enforced across interrupted and retried builds.
SET statement_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting -- deliberate: CREATE INDEX CONCURRENTLY cannot run inside the migrator's transaction, so it is closed here and reopened below
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_source_document_idx"
  ON "case_law_decisions" ("source_id","source_document_id")
  WHERE "source_document_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_source_case_lang_null_idx"
  ON "case_law_decisions" ("source_id","case_number","language")
  WHERE "source_document_id" IS NULL;
--> statement-breakpoint
-- squawk-ignore ban-uncommitted-transaction, transaction-nesting -- reopens the migrator's own transaction, closed above so the concurrent builds could run outside it; Drizzle commits it after writing its bookkeeping row
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
