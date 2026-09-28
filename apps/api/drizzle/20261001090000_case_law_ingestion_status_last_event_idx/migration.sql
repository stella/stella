SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A source's latest ingestion event is an indexed first row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "case_law_ingestion_events_source_finished_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_ingestion_events_source_finished_idx"
  ON "case_law_ingestion_events" ("source_id", "finished_at" DESC);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_ingestion_events_source_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
