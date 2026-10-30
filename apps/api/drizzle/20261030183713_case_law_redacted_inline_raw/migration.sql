SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Keep the pre-column-removal compatibility paths on the same complete
-- tombstone invariant. Old tasks may still perform these updates while the
-- new API and bounded v3 repair roll out.
-- Only clearing the parsed payload signals a legacy redaction: ingestion
-- routinely clears inline source_raw when it moves the raw source to object
-- storage, including on rows that never held a parsed payload.
CREATE OR REPLACE FUNCTION fence_legacy_case_law_redaction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.redacted_at IS NULL
    AND NEW.fulltext IS NULL
    AND NEW.sections IS NULL
    AND NEW.document_ast IS NULL
    AND NEW.content_hash IS NULL
    AND (
      OLD.fulltext IS NOT NULL
      OR OLD.sections IS NOT NULL
      OR OLD.document_ast IS NOT NULL
      OR OLD.content_hash IS NOT NULL
    )
  THEN
    NEW.source_raw := NULL;
    NEW.redacted_at := clock_timestamp();
  END IF;

  IF NEW.redacted_at IS NULL
    AND (
      NEW.fulltext IS NOT NULL
      OR NEW.sections IS NOT NULL
      OR NEW.document_ast IS NOT NULL
      OR NEW.content_hash IS NOT NULL
      OR NEW.source_raw IS NOT NULL
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tombstone_legacy_case_law_redaction_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.operation = 'redact' AND NEW.decision_id IS NOT NULL THEN
    UPDATE "case_law_decisions"
    SET
      "redacted_at" = COALESCE("redacted_at", NEW.created_at),
      "source_raw" = NULL
    WHERE "id" = NEW.decision_id
      AND "redacted_at" IS NULL
      AND "fulltext" IS NULL
      AND "sections" IS NULL
      AND "document_ast" IS NULL
      AND "content_hash" IS NULL;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

-- Replace the historical redaction check with the complete payload invariant.
-- The v3 bounded tombstone backfill clears legacy violations before a later
-- migration validates this constraint; NOT VALID still protects every new
-- insert and update during that repair.
-- stella-migration-safety: reviewed drop-constraint - replaces one unvalidated CHECK atomically with a stronger compatible check; old and new tasks already clear inline raw on ordinary redaction, and rollback is a forward migration restoring the earlier expression.
ALTER TABLE "case_law_decisions"
  DROP CONSTRAINT "case_law_decisions_redacted_payload_erased";
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_redacted_payload_erased"
  CHECK (
    "redacted_at" IS NULL
    OR (
      "fulltext" IS NULL
      AND "sections" IS NULL
      AND "document_ast" IS NULL
      AND "content_hash" IS NULL
      AND "source_raw" IS NULL
    )
  ) NOT VALID;
