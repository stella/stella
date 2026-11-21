-- requires: 20261008160000_case_law_analysis_failures
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_analysis_failures"
  ADD COLUMN "provider_diagnostic" jsonb;
