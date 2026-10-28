-- requires: 20261027160600_case_law_redaction_retirement
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "ai_settlement" jsonb;
