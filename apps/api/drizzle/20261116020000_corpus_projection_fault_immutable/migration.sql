-- requires: 20261115220000_corpus_projection_offline_fault
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- What a committed offline revision's failure is charged to is written with
-- its commit and read by every prover, so it is immutable from the commit
-- on, like the commit instant and the barrier. The function is the one of
-- 20261115130000_corpus_projection_offline_delivery with that one check
-- added; nothing else changes, and no writer of the previous release
-- changes the column after a commit.
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
  IF OLD."append_started_at" IS NOT NULL
     AND (NEW."append_delivery", NEW."append_request_id")
         IS DISTINCT FROM (OLD."append_delivery", OLD."append_request_id") THEN
    RAISE EXCEPTION 'corpus index append delivery is immutable once started';
  END IF;
  IF OLD."append_committed_at" IS NOT NULL
     AND NEW."append_committed_at" IS DISTINCT FROM OLD."append_committed_at" THEN
    RAISE EXCEPTION 'corpus index append commit is immutable once recorded';
  END IF;
  IF OLD."append_committed_at" IS NOT NULL
     AND NEW."append_fault" IS DISTINCT FROM OLD."append_fault" THEN
    RAISE EXCEPTION 'corpus index append fault is immutable once committed';
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
      -- names at its own epoch, and which either exactly one desired change
      -- separates from the desired state (a change of the desired value
      -- needs a strictly newer epoch, so an erasure and its undo take two)
      -- or whose content is exactly what the state desires.
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
        AND state."desired_epoch" > NEW."epoch"
        AND (
          state."desired_epoch" = NEW."epoch" + 1
          OR (
            state."desired_fingerprint" = NEW."fingerprint"
            AND state."desired_index_id" = NEW."index_id"
          )
        )
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
$$;
