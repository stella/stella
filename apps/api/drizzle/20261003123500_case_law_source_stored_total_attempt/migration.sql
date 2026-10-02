-- requires: 20260919140000_case_law_source_stored_total
-- requires: 20260922090000_case_law_source_stored_total_ingestion_grant
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_sources"
  ADD COLUMN "stored_total_attempted_at" timestamp with time zone,
  ADD COLUMN "stored_total_next_refresh_at" timestamp with time zone,
  ADD COLUMN "stored_total_held_since" timestamp with time zone,
  ADD COLUMN "stored_total_warned_slot" timestamp with time zone;
--> statement-breakpoint

GRANT UPDATE (stored_total_attempted_at, stored_total_next_refresh_at, stored_total_held_since, stored_total_warned_slot)
  ON TABLE "case_law_sources"
  TO stella_ingestion;
