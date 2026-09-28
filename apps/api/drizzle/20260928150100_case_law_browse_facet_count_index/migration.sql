SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The scheduled count reads source, jurisdiction, court and date through a
-- partial index on decisions that carry publishable detail.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_browse_facet_count_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_browse_facet_count_idx"
  ON "case_law_decisions" ("source_id", "country", "court", "decision_date")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') is distinct from 'true';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
