-- requires: 20260731170000_case_law_corpus_generation_backfill
-- requires: 20261014120000_case_law_corpus_index_group_cze
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Existing countries are verified uppercase before deployment; this guard does
-- not rewrite corpus rows.
CREATE OR REPLACE FUNCTION enforce_case_law_decisions_corpus_country_shape()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.country !~ '^[A-Z]{2,8}$' OR NEW.country <> upper(NEW.country)
  THEN
    RAISE EXCEPTION 'case_law_decisions_corpus_country_shape: country must contain 2-8 uppercase ASCII letters'
      USING ERRCODE = '23514',
            CONSTRAINT = 'case_law_decisions_corpus_country_shape';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - retry cleanup replaces only the country-shape trigger in this transaction; corpus rows are unchanged, and rollback restores the previous trigger.
DROP TRIGGER IF EXISTS case_law_decisions_corpus_country_shape
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_corpus_country_shape
BEFORE INSERT OR UPDATE
ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION enforce_case_law_decisions_corpus_country_shape();--> statement-breakpoint
