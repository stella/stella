SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Every projection writer shares a row lock with redaction. A writer that
-- started from a stale read therefore either finishes before redaction deletes
-- its projection, or observes the committed tombstone and is rejected.
CREATE OR REPLACE FUNCTION fence_redacted_case_law_search_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1
  FROM "case_law_decisions"
  WHERE "id" = NEW."decision_id"
    AND "redacted_at" IS NULL
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot write a search projection for a redacted case-law decision'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - replaces only this migration's projection fence; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_search_documents_redaction_fence
  ON "case_law_search_documents";--> statement-breakpoint
CREATE TRIGGER case_law_search_documents_redaction_fence
BEFORE INSERT OR UPDATE ON "case_law_search_documents"
FOR EACH ROW
EXECUTE FUNCTION fence_redacted_case_law_search_projection();
