SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A coverage slice whose listing walk fails is now recorded rather than left
-- without a row: `walk_error` carries the reason, and the counts stay null
-- until a walk lists it. Recording it is what lets the historical sweep move
-- past a slice the publisher cannot serve, while the failed rows are retried
-- on their own cadence.
-- stella-migration-safety: reviewed destructive-change - drops NOT NULL on the
-- two count columns so a failed walk can be recorded without counts; the pair
-- and counted-or-failed checks below keep every existing row's shape valid.
-- Rollback: delete rows where walk_error is not null, then restore NOT NULL.
-- The only readers of these columns are the ingestion status endpoint and
-- the reconciliation engine, both of which read null as "not counted".
-- squawk-ignore ban-drop-not-null
ALTER TABLE "case_law_coverage_slices" ALTER COLUMN "reported" DROP NOT NULL;--> statement-breakpoint
-- squawk-ignore ban-drop-not-null
ALTER TABLE "case_law_coverage_slices" ALTER COLUMN "collected" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "case_law_coverage_slices" ADD COLUMN "walk_error" text;--> statement-breakpoint

-- NOT VALID here, VALIDATE below: adding a validating CHECK scans every row
-- while holding ACCESS EXCLUSIVE. NOT VALID takes the lock only long enough
-- to record the constraint, which then applies to every later INSERT and
-- UPDATE. Every existing row has both counts and no error, so both checks
-- validate without a repair step.
ALTER TABLE "case_law_coverage_slices"
  ADD CONSTRAINT "case_law_coverage_slices_counts_pair"
  CHECK (("reported" IS NULL) = ("collected" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_coverage_slices"
  ADD CONSTRAINT "case_law_coverage_slices_counted_or_failed"
  CHECK ("reported" IS NOT NULL OR "walk_error" IS NOT NULL) NOT VALID;--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block, and
-- a VALIDATE outside the transaction that added the constraint does not hold
-- the ADD lock for the scan. Split the migrator transaction, lift the
-- timeouts, then restore and reopen a transaction for Drizzle's migration
-- row. Same shape as 20260818090000_case_law_decision_date_bounds.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_coverage_slices" VALIDATE CONSTRAINT "case_law_coverage_slices_counts_pair";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_coverage_slices" VALIDATE CONSTRAINT "case_law_coverage_slices_counted_or_failed";--> statement-breakpoint
-- The retry arm reads a source's failed rows oldest-checked first.
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before creating it. A cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_coverage_slices_failed_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_coverage_slices_failed_idx" ON "case_law_coverage_slices" ("source_id", "checked_at") WHERE "walk_error" IS NOT NULL;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
