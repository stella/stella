-- requires: 20261031081700_case_law_source_ingestion_config_grant
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Per-source state is written with jsonb_set, which fails on a scalar; some
-- rows hold the JSON string "{}" instead of an object. A NOT VALID check still
-- applies to every later UPDATE of a row, whichever column it writes, so those
-- rows get the object they mean before the constraint exists. The table holds
-- one row per registered source, so the rewrite is bounded by the registry.
UPDATE "case_law_sources" SET "config" = '{}'::jsonb
  WHERE jsonb_typeof("config") = 'string' AND "config" #>> '{}' = '{}';--> statement-breakpoint
-- Any other non-object value has no known meaning: stop instead of guessing or
-- leaving a source unable to take any write.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "case_law_sources" WHERE jsonb_typeof("config") <> 'object'
  ) THEN
    RAISE EXCEPTION 'case_law_sources.config holds a non-object value; map it explicitly first';
  END IF;
END
$$;--> statement-breakpoint
-- New writes are held to an object here; the online repair
-- (case-law-source-config-object-repair.ts) validates the constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only the constraint the next statement re-adds, so a retried migration re-enters the same state; no data is touched and rollback is dropping it again.
ALTER TABLE "case_law_sources"
  -- squawk-ignore ban-drop-constraint
  DROP CONSTRAINT IF EXISTS "case_law_sources_config_object";--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_config_object"
  CHECK (jsonb_typeof("config") = 'object')
  NOT VALID;
