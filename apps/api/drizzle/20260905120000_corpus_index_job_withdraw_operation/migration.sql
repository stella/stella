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
-- Widening an IN list revalidates nothing that was already accepted, so
-- both statements are metadata-only apart from the constraint re-check
-- Postgres runs over existing rows, which every current value satisfies.
ALTER TABLE "case_law_index_jobs"
  DROP CONSTRAINT IF EXISTS "case_law_index_jobs_operation_values";--> statement-breakpoint
ALTER TABLE "case_law_index_jobs"
  ADD CONSTRAINT "case_law_index_jobs_operation_values"
  CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild', 'withdraw'));--> statement-breakpoint

-- The vocabulary is declared once and feeds both tables, so both move.
ALTER TABLE "legislation_index_jobs"
  DROP CONSTRAINT IF EXISTS "legislation_index_jobs_operation_values";--> statement-breakpoint
ALTER TABLE "legislation_index_jobs"
  ADD CONSTRAINT "legislation_index_jobs_operation_values"
  CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild', 'withdraw'));
