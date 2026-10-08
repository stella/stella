-- requires: 20260830120000_signals
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A pending deadline scan refused for an exhausted action period waits for
-- the period's end. The column is nullable without a default, so adding it
-- rewrites nothing; the previous release never writes it.
ALTER TABLE "document_processing_runs" ADD COLUMN IF NOT EXISTS "deadline_scout_skipped_until" timestamp with time zone;--> statement-breakpoint
-- Added NOT VALID; 20261005140100 validates it outside this transaction.
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_deadline_scout_skip_check" CHECK ("deadline_scout_skipped_until" IS NULL OR ("deadline_scout_status" = 'pending' AND "deadline_scout_error_code" IS NOT NULL)) NOT VALID;
