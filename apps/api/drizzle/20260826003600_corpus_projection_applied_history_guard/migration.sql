SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- applied_revision is an immutable pointer to the last successfully applied
-- append. It remains valid while that exact revision advances through cleanup.
CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_epoch bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."family", NEW."generation", NEW."entity_id", NEW."created_at")
       IS DISTINCT FROM
       (OLD."family", OLD."generation", OLD."entity_id", OLD."created_at") THEN
      RAISE EXCEPTION 'corpus index projection state identity is immutable';
    END IF;
    IF NEW."desired_epoch" < OLD."desired_epoch" THEN
      RAISE EXCEPTION 'corpus index desired epoch cannot decrease';
    END IF;
    IF (NEW."desired_action", NEW."desired_fingerprint", NEW."desired_index_id")
       IS DISTINCT FROM (OLD."desired_action", OLD."desired_fingerprint", OLD."desired_index_id")
       AND NEW."desired_epoch" <= OLD."desired_epoch" THEN
      RAISE EXCEPTION 'changed corpus index desired state requires a newer epoch';
    END IF;
    IF OLD."applied_epoch" IS NOT NULL
       AND (NEW."applied_epoch" IS NULL OR NEW."applied_epoch" < OLD."applied_epoch") THEN
      RAISE EXCEPTION 'corpus index applied epoch cannot decrease';
    END IF;
  END IF;

  IF NEW."family" = 'case_law' THEN
    SELECT "projection_epoch" INTO canonical_epoch
    FROM "case_law_decisions"
    WHERE "id" = NEW."entity_id";
  ELSIF NEW."family" = 'legislation' THEN
    SELECT "projection_epoch" INTO canonical_epoch
    FROM "legislation_documents"
    WHERE "id" = NEW."entity_id";
  END IF;
  IF canonical_epoch IS NULL OR canonical_epoch <> NEW."desired_epoch" THEN
    RAISE EXCEPTION 'corpus index desired epoch must match the canonical row';
  END IF;

  IF NEW."applied_action" = 'upsert' AND NOT EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."id" = NEW."applied_revision"
      AND intent."family" = NEW."family"
      AND intent."generation" = NEW."generation"
      AND intent."entity_id" = NEW."entity_id"
      AND intent."epoch" = NEW."applied_epoch"
      AND intent."fingerprint" = NEW."applied_fingerprint"
      AND intent."index_id" = NEW."applied_index_id"
      AND intent."status" IN (
        'applied',
        'cleanup_pending',
        'cleanup_started',
        'cleanup_committed',
        'settled'
      )
  ) THEN
    RAISE EXCEPTION 'applied corpus index state requires its exact applied history intent';
  END IF;

  IF NEW."applied_action" = 'erase' AND EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."family" = NEW."family"
      AND intent."generation" = NEW."generation"
      AND intent."entity_id" = NEW."entity_id"
      AND intent."epoch" <= NEW."applied_epoch"
      AND intent."status" NOT IN ('settled', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'erased corpus index state requires every prior revision settled';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
