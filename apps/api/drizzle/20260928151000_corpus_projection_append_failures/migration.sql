SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Projection execution has not shipped, so no running API task writes these
-- inert rows. Replace both checks in one transaction before the new failure
-- states are written.
-- stella-migration-safety: reviewed drop-constraint - Projection execution has not shipped, so no running API task writes these inert rows; this transaction immediately installs replacement constraints and rolls back atomically on failure.
ALTER TABLE "corpus_index_projection_states"
  DROP CONSTRAINT "corpus_index_projection_states_failure_kind_values",
  DROP CONSTRAINT "corpus_index_projection_states_work_shape";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD CONSTRAINT "corpus_index_projection_states_failure_kind_values"
    CHECK (
      "last_failure_kind" IS NULL
      OR "last_failure_kind" IN (
        'payload_unavailable',
        'revision_too_large',
        'append_unknown',
        'append_rejected'
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
        AND (
          ("failure_attempts" = 0
            AND "last_failure_kind" IS NULL
            AND "last_failure_message" IS NULL)
          OR ("failure_attempts" = 0
            AND "last_failure_kind" = 'append_rejected'
            AND "last_failure_message" IS NOT NULL)
          OR ("failure_attempts" > 0
            AND "last_failure_kind" IS NOT NULL
            AND "last_failure_message" IS NOT NULL)
        )
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
