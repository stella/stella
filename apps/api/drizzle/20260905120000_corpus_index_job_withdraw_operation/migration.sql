SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A fifth operation for the corpus index-job audit trail: `withdraw`.
--
-- A withdrawal takes back a document whose stored payload no longer parses
-- as one, keeping the row, its identity and its stored payload so a later
-- parser can replay it. `redact` cannot stand in for it: a redact row is
-- read as a takedown tombstone, and recording a withdrawal that way would
-- mark the decision permanently erased.
--
-- Widening an IN list accepts every value the old list accepted, so the
-- constraint is re-added NOT VALID: nothing existing needs a scan, and every
-- later INSERT and UPDATE is checked. Dropped by name and re-added so a
-- second run re-records the same constraint. Rollback is the same pair with
-- the previous list, which every row written before this migration satisfies.
-- stella-migration-safety: reviewed drop-constraint - drops only this check,
-- re-added in the next statement with one more accepted value
ALTER TABLE "case_law_index_jobs"
  DROP CONSTRAINT IF EXISTS "case_law_index_jobs_operation_values";--> statement-breakpoint
ALTER TABLE "case_law_index_jobs"
  ADD CONSTRAINT "case_law_index_jobs_operation_values"
  CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild', 'withdraw')) NOT VALID;--> statement-breakpoint

-- The vocabulary is declared once and feeds both tables, so both move.
-- stella-migration-safety: reviewed drop-constraint - drops only this check,
-- re-added in the next statement with one more accepted value
ALTER TABLE "legislation_index_jobs"
  DROP CONSTRAINT IF EXISTS "legislation_index_jobs_operation_values";--> statement-breakpoint
ALTER TABLE "legislation_index_jobs"
  ADD CONSTRAINT "legislation_index_jobs_operation_values"
  CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild', 'withdraw')) NOT VALID;
