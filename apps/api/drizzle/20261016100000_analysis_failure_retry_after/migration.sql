-- requires: 20261011005000_analysis_provider_diagnostic
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The time a provider asked a failed analysis run not to be retried before.
-- Nullable with no default: a metadata-only column add; existing records
-- simply carry none.
ALTER TABLE "case_law_analysis_failures" ADD COLUMN "retry_after" timestamptz;
