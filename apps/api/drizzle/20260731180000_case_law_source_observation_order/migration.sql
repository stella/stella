SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive ordering token for replay-safe overlapping source deliveries.
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "source_observed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "source_observation_hash" varchar(64);--> statement-breakpoint
