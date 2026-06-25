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
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_slug_uidx"
  ON "case_law_decisions" ("slug")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint
BEGIN;
