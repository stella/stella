-- requires: 20261031081700_case_law_source_ingestion_config_grant
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Per-source state is written with jsonb_set, which fails on a scalar; some
-- rows hold the JSON string "{}" instead of an object. New writes are held to
-- an object here; the online repair (case-law-source-config-object-repair.ts)
-- rewrites the existing rows and validates the constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only the constraint the next statement re-adds, so a retried migration re-enters the same state; no data is touched and rollback is dropping it again.
ALTER TABLE "case_law_sources"
  DROP CONSTRAINT IF EXISTS "case_law_sources_config_object";--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_config_object"
  CHECK (jsonb_typeof("config") = 'object')
  NOT VALID;
