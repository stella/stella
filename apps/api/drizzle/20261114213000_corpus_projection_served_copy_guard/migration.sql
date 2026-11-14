SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Cleanup never deletes the copy an upsert state still serves. Two moves the
-- guards refused until now make that possible, and both only add an allowed
-- transition: every write an earlier release makes passes these functions
-- exactly as it passed their predecessors.
--
-- 1. `cleanup_pending -> applied` (restore): a revision queued for cleanup
--    while its state still served it, before any delete was issued for it,
--    returns to `applied`. The predicate is the one the cleanup claim evaluates
--    (`corpusIndexProjectionRevisionIsRestorable`), repeated here so no writer
--    can restore anything else.
-- 2. An upsert state may stop naming its revision (applied action back to
--    missing) once that revision is no longer `applied`, so un-naming can never
--    orphan a served copy: erasure and drift repair move the revision to
--    cleanup first, then un-name it, in one transaction.
CREATE OR REPLACE FUNCTION "corpus_index_projection_intent_transition_allowed"(
  from_status text,
  to_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE from_status
    WHEN 'reserved' THEN to_status IN ('append_started','cancelled')
    WHEN 'append_started' THEN to_status IN ('append_committed','cleanup_pending')
    WHEN 'append_committed' THEN to_status IN ('applied','cleanup_pending')
    WHEN 'applied' THEN to_status = 'cleanup_pending'
    WHEN 'cleanup_pending' THEN to_status IN ('cleanup_started','applied')
    WHEN 'cleanup_started' THEN to_status IN ('cleanup_pending','cleanup_committed')
    WHEN 'cleanup_committed' THEN to_status IN ('settled','cleanup_pending','cleanup_stalled')
    WHEN 'cleanup_stalled' THEN to_status = 'cleanup_pending'
    WHEN 'settled' THEN to_status = 'cleanup_pending'
    ELSE false
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_intent_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF (NEW."id", NEW."family", NEW."generation", NEW."entity_id", NEW."epoch", NEW."fingerprint", NEW."index_id", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."family", OLD."generation", OLD."entity_id", OLD."epoch", OLD."fingerprint", OLD."index_id", OLD."created_at") THEN
    RAISE EXCEPTION 'corpus index projection intent identity is immutable';
  END IF;

  IF NEW."cleanup_attempts" < OLD."cleanup_attempts" THEN
    RAISE EXCEPTION 'corpus index projection cleanup attempts cannot decrease';
  END IF;

  IF OLD."append_started_at" IS NOT NULL
     AND NEW."append_started_at" IS DISTINCT FROM OLD."append_started_at" THEN
    RAISE EXCEPTION 'corpus index append start is immutable once recorded';
  END IF;
  IF OLD."append_committed_at" IS NOT NULL
     AND NEW."append_committed_at" IS DISTINCT FROM OLD."append_committed_at" THEN
    RAISE EXCEPTION 'corpus index append commit is immutable once recorded';
  END IF;
  IF OLD."applied_at" IS NOT NULL
     AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
    RAISE EXCEPTION 'corpus index apply time is immutable once recorded';
  END IF;
  IF OLD."append_publish_barrier_at" IS NOT NULL
     AND NEW."append_publish_barrier_at" IS DISTINCT FROM OLD."append_publish_barrier_at" THEN
    RAISE EXCEPTION 'corpus index append barrier is immutable once recorded';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    transition_allowed := corpus_index_projection_intent_transition_allowed(
      OLD."status",
      NEW."status"
    );
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid corpus index projection intent transition: % -> %', OLD."status", NEW."status";
    END IF;
    IF OLD."status" = 'cleanup_pending' AND NEW."status" = 'applied' THEN
      -- A restore is not a new append: the state's desired epoch has moved
      -- past this revision, which is why it was queued. It is admitted only
      -- for a revision no delete can have reached, which the state still
      -- names at its own epoch, and whose desired value has not changed
      -- since it was queued.
      IF NOT (
        OLD."cleanup_attempts" = 0
        AND NEW."cleanup_attempts" = 0
        AND OLD."applied_at" IS NOT NULL
        AND OLD."last_error" IS NULL
      ) THEN
        RAISE EXCEPTION 'only a never-deleted revision can be restored';
      END IF;
      PERFORM 1
      FROM "corpus_index_projection_states" state
      WHERE state."applied_revision" = NEW."id"
        AND state."desired_action" = 'upsert'
        AND state."applied_action" = 'upsert'
        AND state."applied_epoch" = NEW."epoch"
        AND state."desired_at" IS NOT NULL
        AND state."desired_at" < OLD."updated_at"
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'only a revision its unchanged upsert state still names can be restored';
      END IF;
    ELSIF NEW."status" IN ('append_started','append_committed','applied')
    THEN
      PERFORM 1
      FROM "corpus_index_projection_states" state
      WHERE state."family" = NEW."family"
        AND state."generation" = NEW."generation"
        AND state."entity_id" = NEW."entity_id"
        AND state."desired_action" = 'upsert'
        AND state."desired_epoch" = NEW."epoch"
        AND state."desired_fingerprint" = NEW."fingerprint"
        AND state."desired_index_id" = NEW."index_id"
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'stale corpus index projection intent cannot advance';
      END IF;
    END IF;
  END IF;

  IF OLD."status" = 'applied' AND NEW."status" = 'cleanup_pending'
     AND EXISTS (
       SELECT 1 FROM "corpus_index_projection_states" state
       WHERE state."applied_revision" = OLD."id"
         AND state."desired_action" <> 'erase'
         AND state."desired_epoch" <= OLD."epoch"
         AND NOT (
           state."work_status" = 'repair_scheduled'
           AND state."desired_action" = 'upsert'
           AND state."desired_epoch" = OLD."epoch"
           AND state."desired_fingerprint" = OLD."fingerprint"
           AND state."desired_index_id" = OLD."index_id"
         )
     ) THEN
    RAISE EXCEPTION 'current corpus index projection revision requires newer desired state or exact repair before cleanup';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

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
    -- The row runs after the statements that moved its revision, so it sees
    -- the revision's new status: un-naming is admitted only once the copy it
    -- named has left `applied`.
    IF OLD."applied_epoch" IS NOT NULL
       AND (NEW."applied_epoch" IS NULL OR NEW."applied_epoch" < OLD."applied_epoch")
       AND NOT (
         OLD."applied_action" = 'erase'
         AND NEW."applied_action" IS NULL
       )
       AND NOT (
         OLD."applied_action" = 'upsert'
         AND NEW."applied_action" IS NULL
         AND EXISTS (
           SELECT 1
           FROM "corpus_index_projection_intents" named
           WHERE named."id" = OLD."applied_revision"
             AND named."status" <> 'applied'
         )
       ) THEN
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
  IF canonical_epoch IS NULL THEN
    IF TG_OP <> 'UPDATE'
       OR OLD."desired_action" IS DISTINCT FROM 'erase'
       OR (NEW."desired_action", NEW."desired_epoch", NEW."desired_fingerprint", NEW."desired_index_id")
          IS DISTINCT FROM
          (OLD."desired_action", OLD."desired_epoch", OLD."desired_fingerprint", OLD."desired_index_id")
    THEN
      RAISE EXCEPTION 'corpus index desired epoch must match the canonical row';
    END IF;
  ELSIF canonical_epoch <> NEW."desired_epoch" THEN
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
$$;
