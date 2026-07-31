SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Once a decision has entered ordered source observation handling, reject the
-- legacy refresh statement shape. PostgreSQL UPDATE OF fires when source_hash
-- is targeted even if its value is unchanged, while the ordered writer always
-- advances source_observation_order in that same statement.
CREATE OR REPLACE FUNCTION prevent_legacy_case_law_source_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.source_observation_order IS NOT NULL
    AND NEW.source_observation_order IS NOT DISTINCT FROM OLD.source_observation_order
  THEN
    RAISE EXCEPTION 'case-law source refresh must advance source_observation_order'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

DROP TRIGGER IF EXISTS case_law_decisions_source_refresh_order_fence
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_source_refresh_order_fence
BEFORE UPDATE OF source_hash ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION prevent_legacy_case_law_source_refresh();--> statement-breakpoint
