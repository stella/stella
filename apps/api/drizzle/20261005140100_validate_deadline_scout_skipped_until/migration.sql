-- requires: 20261005140000_deadline_scout_skipped_until
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate without retaining the constraint DDL locks through the scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so the scan does not retain DDL locks.
ALTER TABLE "document_processing_runs" VALIDATE CONSTRAINT "document_processing_runs_deadline_scout_skip_check";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
