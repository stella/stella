SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- What the export was asked for. Until now the format and the AI-narrative
-- flag existed only on the queued job, so an export whose job the queue no
-- longer holds could not be handed back: the row records that work is owed
-- but not what to run. Persisting both makes the row the whole request.
--
-- Nullable with no default. A default would be a claim about rows written
-- before this migration, and it would be wrong for exactly the rows that
-- matter: an export that asked for `pdf` or turned the narrative off carried
-- that only on its job, so backfilling 'docx'/true would relabel it and the
-- reconciler would hand a different request back to the queue. NULL says "the
-- request was never recorded", which the sweep can act on honestly. Every new
-- write sets both columns.
--
-- Adding a nullable column with no default writes no row.
ALTER TABLE "report_exports"
  ADD COLUMN IF NOT EXISTS "format" text;--> statement-breakpoint
ALTER TABLE "report_exports"
  ADD COLUMN IF NOT EXISTS "ai_narrative" boolean;--> statement-breakpoint

-- Drizzle's `text({ enum })` is compile-time only, and the worker branches on
-- this value to pick the conversion and name the artifact, so the column
-- states the rule itself. NULL is admitted: it is the pre-migration "no
-- request recorded" state, not a format.
--
-- Dropped by name and re-added in one statement rather than added outright:
-- every statement ahead of the transaction split below has to be repeatable,
-- because a cancelled or failed concurrent index build leaves the migration
-- unrecorded and the next `db:migrate` replays this file from the top. A bare
-- ADD CONSTRAINT would abort on duplicate_object and the invalid-index repair
-- below would never be reached.
--
-- Validating rather than NOT VALID + VALIDATE: the column was just created and
-- holds NULL in every existing row, so the scan has nothing to reject.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it unchanged in the same statement, so no row data is touched and a replay of this file is a no-op. The constraint does not exist before this migration.
ALTER TABLE "report_exports"
  DROP CONSTRAINT IF EXISTS "report_exports_format_values_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "report_exports_format_values_check"
  CHECK ("format" IS NULL OR "format" IN ('docx', 'pdf'));--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260903120000_queue_reconciler_indexes.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- The build drops its own index by name first: a cancelled concurrent build
-- leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "report_exports_queued_idx";
--> statement-breakpoint
-- The reconciler walks exports still waiting for a worker in creation order,
-- keyset-paginated, and stops at its page. Without this the walk sorts the
-- whole export history on every sweep. Partial on the column the sweep
-- filters, so the index stays the size of the outstanding work rather than of
-- every export ever run.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "report_exports_queued_idx"
  ON "report_exports" ("created_at", "id")
  WHERE "status" = 'queued';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
