SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- The cross-publisher lookup index on case_law_decisions is built in the
-- online phase (ONLINE_MIGRATION_INDEXES), not here.
ALTER TABLE "case_law_decision_source_identities"
  ADD COLUMN IF NOT EXISTS "source_raw_s3_key" varchar(512),
  ADD COLUMN IF NOT EXISTS "source_raw_content_type" varchar(128),
  ADD COLUMN IF NOT EXISTS "source_url" varchar(2048),
  ADD COLUMN IF NOT EXISTS "source_observed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "source_observation_order" bigint;
