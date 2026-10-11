SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only an invalid remnant from this migration's concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_decision_date_coverage_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_source_decision_date_coverage_idx"
  ON "case_law_decisions" ("source_id", "decision_date", "id")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
