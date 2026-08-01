-- The unique slug index is built CONCURRENTLY so it never write-locks
-- case_law_decisions, which holds millions of rows. Drizzle wraps pending
-- migrations in one transaction, but CREATE INDEX CONCURRENTLY must run
-- outside a transaction block: COMMIT the migrator transaction, build the
-- index, then reopen with BEGIN for Drizzle's migration bookkeeping row
-- (same split as 20260605143000_workflow_pending_fields_index).
--
-- Slug *values* are not backfilled here. The corpus can hold millions of
-- rows, which is too large for a single in-transaction UPDATE to finish
-- within statement_timeout. New decisions get a unique slug at ingest time
-- via the case-law slug helper; existing rows are filled by the idempotent,
-- batched maintenance script src/scripts/backfill-case-law-slugs.ts. The
-- partial predicate keeps the index valid while legacy rows still carry a
-- NULL slug.
--
-- The migration runner validates this index after the ledger update and
-- concurrently repairs an interrupted INVALID build. IF NOT EXISTS preserves
-- an already-valid uniqueness boundary when a prior run reached the index but
-- stopped before recording the migration.
SET statement_timeout = 0;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_slug_uidx"
  ON "case_law_decisions" ("slug")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET statement_timeout = DEFAULT;
