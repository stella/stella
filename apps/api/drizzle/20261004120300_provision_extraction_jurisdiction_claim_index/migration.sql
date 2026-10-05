-- requires: 20260926160000_case_law_provision_extraction_state
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Concurrent builds run outside the migrator transaction.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- Retry cleanup replaces only this migration's index after an interrupted build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_provision_extractions_jurisdiction_due_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_provision_extractions_jurisdiction_due_idx"
  ON "case_law_provision_extractions" ("jurisdiction", "lane", "due_at", "decision_id")
  WHERE "due_at" IS NOT NULL AND "work_status" <> 'blocked';
--> statement-breakpoint

SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
