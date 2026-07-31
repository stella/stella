SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive ordering token for replay-safe overlapping source deliveries.
ALTER TABLE "case_law_sources" ADD COLUMN IF NOT EXISTS "observation_order" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "source_observed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "source_observation_order" bigint;--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "source_observation_hash" varchar(64);--> statement-breakpoint
