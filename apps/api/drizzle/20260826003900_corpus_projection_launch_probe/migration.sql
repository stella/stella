SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Projection execution is not active yet. Add the explicit same-epoch repair
-- queue before bootstrap, preserving monotonic applied history while census
-- drift retires and replaces one exact attempt.
-- stella-migration-safety: reviewed drop-constraint - Projection execution has not shipped, so no running API task writes these inert rows; this transaction immediately installs stricter replacement constraints and rolls back atomically on failure.
ALTER TABLE "corpus_index_projection_states"
  DROP CONSTRAINT "corpus_index_projection_states_work_status_values",
  DROP CONSTRAINT "corpus_index_projection_states_work_shape";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD CONSTRAINT "corpus_index_projection_states_work_status_values"
    CHECK (
      "work_status" IN (
        'eligible',
        'retry_scheduled',
        'repair_scheduled',
        'blocked'
      )
    ) NOT VALID,
  ADD CONSTRAINT "corpus_index_projection_states_work_shape"
    CHECK (CASE "work_status"
      WHEN 'eligible' THEN
        "retry_not_before" IS NULL
        AND "failure_attempts" = 0
        AND "last_failure_kind" IS NULL
        AND "last_failure_message" IS NULL
      WHEN 'retry_scheduled' THEN
        "retry_not_before" IS NOT NULL
        AND "failure_attempts" > 0
        AND "last_failure_kind" IS NOT NULL
        AND "last_failure_message" IS NOT NULL
      WHEN 'repair_scheduled' THEN
        "retry_not_before" IS NULL
        AND "failure_attempts" = 0
        AND "last_failure_kind" IS NULL
        AND "last_failure_message" IS NULL
      WHEN 'blocked' THEN
        "retry_not_before" IS NULL
        AND "failure_attempts" > 0
        AND "last_failure_kind" IS NOT NULL
        AND "last_failure_message" IS NOT NULL
      ELSE false
    END) NOT VALID;--> statement-breakpoint

-- Same-epoch repair deliberately retires the currently applied immutable
-- revision before rebuilding it. Keep the original replacement fence for
-- every other path; only the exact explicit repair state may cross it.
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
    IF NEW."status" IN ('append_started','append_committed','applied')
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

-- squawk-ignore require-concurrent-index-deletion
DROP INDEX "corpus_index_projection_states_pending_idx";--> statement-breakpoint

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "corpus_index_projection_states_pending_idx"
  ON "corpus_index_projection_states" (
    "family",
    "generation",
    (coalesce("retry_not_before", "updated_at")),
    "entity_id"
  )
  WHERE "work_status" = 'repair_scheduled'
    OR (
      "work_status" IN ('eligible', 'retry_scheduled')
      AND (
        "applied_action" IS NULL
        OR "applied_action" IS DISTINCT FROM "desired_action"
        OR "applied_epoch" IS DISTINCT FROM "desired_epoch"
        OR "applied_fingerprint" IS DISTINCT FROM "desired_fingerprint"
        OR "applied_index_id" IS DISTINCT FROM "desired_index_id"
      )
    );--> statement-breakpoint

-- The final projection tables remain inert until Plane is released with the
-- v5/v2 executor. Install the empty-table launch probe before bootstrap; this
-- keeps every later zero-blocked proof index-only.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "corpus_index_projection_states_blocked_idx"
  ON "corpus_index_projection_states" (
    "family",
    "generation",
    "entity_id"
  )
  WHERE "work_status" = 'blocked';--> statement-breakpoint
