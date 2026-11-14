SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Every redaction writer now sets redacted_at itself. A payload cleared
-- without it is a withdrawal or an empty settle, which keeps the row; only
-- the guard against restoring a historically redacted payload remains.
CREATE OR REPLACE FUNCTION fence_legacy_case_law_redaction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.redacted_at IS NULL
    AND (
      NEW.fulltext IS NOT NULL
      OR NEW.sections IS NOT NULL
      OR NEW.document_ast IS NOT NULL
      OR NEW.content_hash IS NOT NULL
    )
    AND EXISTS (
      SELECT 1
      FROM "case_law_index_jobs" AS redaction_audit
      WHERE redaction_audit."decision_id" = OLD."id"
        AND redaction_audit."operation" = 'redact'
    )
  THEN
    RAISE EXCEPTION 'cannot restore a historically redacted case-law payload'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;
