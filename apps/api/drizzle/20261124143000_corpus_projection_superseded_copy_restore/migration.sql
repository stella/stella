-- requires: 20261116020000_corpus_projection_fault_immutable
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Cleanup returns a queued copy its upsert state still serves to `applied`
-- when no erasure is recorded since the copy was reserved, although more than
-- one desired change has gone by. The guard asks the same question, so no
-- writer can restore anything else. It is the one of
-- 20261116020000_corpus_projection_fault_immutable with the restore branch
-- asking the function below; it only admits a transition it refused, and every
-- write of the previous release passes it exactly as it passed its
-- predecessor.

-- Whether a queued copy is one its upsert state keeps serving: no delete can
-- have reached it, nothing recorded why it was queued, the state names it at
-- its own epoch from the index it desires, and no erasure is recorded since
-- the copy was reserved; or the projection rows alone prove it, by a single
-- desired change or by equal content (a change of the desired value needs a
-- strictly newer epoch, so an erasure and its undo take two).
--
-- The predicate is the cleanup claim's (`corpusIndexProjectionRevisionIsRestorable`,
-- `corpusIndexProjectionRevisionKeepsServing`, `corpusProjectionErasureIsExcluded`).
-- The naming state is locked first and the records are read by a later
-- statement, so they include every erasure committed before the lock was
-- granted. A revision that records why it was queued, or that no state names,
-- costs no record read; the records are probed by the decision's id.
CREATE FUNCTION "corpus_index_projection_queued_copy_is_kept"(
  revision "corpus_index_projection_intents"
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE
  copy_is_proven boolean;
  copy_is_in_desired_index boolean;
BEGIN
  IF revision."cleanup_attempts" <> 0
     OR revision."applied_at" IS NULL
     OR revision."last_error" IS NOT NULL THEN
    RETURN false;
  END IF;
  SELECT
    state."desired_epoch" = revision."epoch" + 1
    OR (
      state."desired_fingerprint" = revision."fingerprint"
      AND state."desired_index_id" = revision."index_id"
    ),
    state."desired_index_id" = revision."index_id"
  INTO copy_is_proven, copy_is_in_desired_index
  FROM "corpus_index_projection_states" state
  WHERE state."applied_revision" = revision."id"
    AND state."desired_action" = 'upsert'
    AND state."applied_action" = 'upsert'
    AND state."applied_epoch" = revision."epoch"
    AND state."desired_epoch" > revision."epoch"
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF copy_is_proven THEN
    RETURN true;
  END IF;
  IF NOT copy_is_in_desired_index OR revision."family" <> 'case_law' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM "case_law_decisions" decision
    WHERE decision."id" = revision."entity_id"
      AND decision."redacted_at" IS NULL
      AND (
        decision."content_hash" IS NOT NULL
        OR decision."corpus_mirror_status" = 'pending'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "case_law_index_jobs" job
    WHERE job."decision_id" = revision."entity_id"
      AND (
        job."operation" = 'redact'
        OR (
          job."operation" = 'withdraw'
          AND job."status" = 'succeeded'
          AND job."created_at" >= revision."created_at"
        )
      )
  );
END;
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
      -- past this revision, which is why it was queued.
      IF NEW."cleanup_attempts" <> 0
         OR NOT corpus_index_projection_queued_copy_is_kept(OLD) THEN
        RAISE EXCEPTION 'only a queued copy its upsert state keeps serving can be restored';
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
