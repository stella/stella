-- requires: 20261031081700_case_law_source_ingestion_config_grant
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Some source rows hold the JSON string "{}" instead of an object, and
-- jsonb_set on a scalar fails, so per-source state could never be recorded
-- for them. Store the empty object they mean, then refuse any non-object.
UPDATE "case_law_sources"
  SET "config" = '{}'::jsonb
  WHERE jsonb_typeof("config") = 'string' AND "config" #>> '{}' = '{}';--> statement-breakpoint

-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state.
ALTER TABLE "case_law_sources"
  DROP CONSTRAINT IF EXISTS "case_law_sources_config_object";--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_config_object"
  CHECK (jsonb_typeof("config") = 'object')
  NOT VALID;
