SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD COLUMN "work_status" text DEFAULT 'eligible' NOT NULL,
  ADD COLUMN "retry_not_before" timestamptz,
  ADD COLUMN "failure_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "last_failure_kind" text,
  ADD COLUMN "last_failure_message" varchar(2048);--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD CONSTRAINT "corpus_index_projection_states_work_status_values"
    CHECK ("work_status" IN ('eligible', 'retry_scheduled', 'blocked')) NOT VALID,
  ADD CONSTRAINT "corpus_index_projection_states_failure_kind_values"
    CHECK (
      "last_failure_kind" IS NULL
      OR "last_failure_kind" IN ('payload_unavailable', 'revision_too_large')
    ) NOT VALID,
  ADD CONSTRAINT "corpus_index_projection_states_failure_attempts_nonnegative"
    CHECK ("failure_attempts" >= 0) NOT VALID,
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
      WHEN 'blocked' THEN
        "retry_not_before" IS NULL
        AND "failure_attempts" > 0
        AND "last_failure_kind" IS NOT NULL
        AND "last_failure_message" IS NOT NULL
      ELSE false
    END) NOT VALID;--> statement-breakpoint

-- The table remains inert until the executor ships. Replace the original
-- pending index before bootstrap so one partial index owns runnable work and
-- blocked rows never inflate the scheduler's scan surface.
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
  WHERE "work_status" IN ('eligible', 'retry_scheduled')
    AND (
      "applied_action" IS NULL
      OR "applied_action" IS DISTINCT FROM "desired_action"
      OR "applied_epoch" IS DISTINCT FROM "desired_epoch"
      OR "applied_fingerprint" IS DISTINCT FROM "desired_fingerprint"
      OR "applied_index_id" IS DISTINCT FROM "desired_index_id"
    );--> statement-breakpoint

CREATE FUNCTION "guard_corpus_index_projection_work_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."desired_action", NEW."desired_epoch", NEW."desired_fingerprint", NEW."desired_index_id")
         IS DISTINCT FROM
         (OLD."desired_action", OLD."desired_epoch", OLD."desired_fingerprint", OLD."desired_index_id")
     AND (
       NEW."work_status" <> 'eligible'
       OR NEW."retry_not_before" IS NOT NULL
       OR NEW."failure_attempts" <> 0
       OR NEW."last_failure_kind" IS NOT NULL
       OR NEW."last_failure_message" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'changed corpus index desired state must reset work eligibility';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_states_work_guard"
  BEFORE UPDATE ON "corpus_index_projection_states"
  FOR EACH ROW EXECUTE FUNCTION "guard_corpus_index_projection_work_state"();--> statement-breakpoint
