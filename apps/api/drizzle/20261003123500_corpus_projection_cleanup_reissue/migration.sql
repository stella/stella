SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A delete task cannot reach a revision written after it, so its settlement
-- can wait forever. Such revisions go back to cleanup for a new delete, a
-- bounded number of times, and then stall in a status of their own.
ALTER TABLE "corpus_index_projection_intents"
  ADD COLUMN "delete_reissues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- The checks below are added NOT VALID: the table grows with the corpus, so the
-- online repair `corpus-projection-cleanup-stall` validates them outside the
-- migration's statement budget. New writes are checked from here on.
ALTER TABLE "corpus_index_projection_intents"
  ADD CONSTRAINT "corpus_index_projection_intents_delete_reissues_nonnegative"
    CHECK ("delete_reissues" >= 0) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - The same atomic statement replaces the status list with a superset; every existing status stays allowed.
ALTER TABLE "corpus_index_projection_intents"
  DROP CONSTRAINT "corpus_index_projection_intents_status_values",
  ADD CONSTRAINT "corpus_index_projection_intents_status_values"
    CHECK ("status" IN (
      'reserved','append_started','append_committed','applied',
      'cleanup_pending','cleanup_started','cleanup_committed','cleanup_stalled',
      'settled','cancelled'
    )) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - The same atomic statement replaces the status shape with one that adds the stalled branch; every existing branch is unchanged.
ALTER TABLE "corpus_index_projection_intents"
  DROP CONSTRAINT "corpus_index_projection_intents_status_shape",
  ADD CONSTRAINT "corpus_index_projection_intents_status_shape"
    CHECK (CASE "status"
      WHEN 'reserved' THEN
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'append_started' THEN
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'append_committed' THEN
        "lease_token" IS NOT NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'applied' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_pending' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_started' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_committed' THEN
        "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'cleanup_stalled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NULL
      WHEN 'settled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NOT NULL
        AND "append_publish_barrier_at" IS NOT NULL
        AND "cleanup_not_before" IS NOT NULL
        AND "cleanup_started_at" IS NOT NULL
        AND "delete_opstamp" IS NOT NULL
        AND "settled_at" IS NOT NULL
        AND "cancelled_at" IS NULL
      WHEN 'cancelled' THEN
        "lease_token" IS NULL
        AND "append_started_at" IS NULL
        AND "append_committed_at" IS NULL
        AND "applied_at" IS NULL
        AND "append_publish_barrier_at" IS NULL
        AND "cleanup_not_before" IS NULL
        AND "cleanup_started_at" IS NULL
        AND "delete_opstamp" IS NULL
        AND "settled_at" IS NULL
        AND "cancelled_at" IS NOT NULL
      ELSE false
    END) NOT VALID;--> statement-breakpoint

-- A committed delete either settles, goes back to cleanup for a new delete, or
-- stalls; only an operator moves a stalled revision back to cleanup.
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
    WHEN 'cleanup_pending' THEN to_status = 'cleanup_started'
    WHEN 'cleanup_started' THEN to_status IN ('cleanup_pending','cleanup_committed')
    WHEN 'cleanup_committed' THEN to_status IN ('settled','cleanup_pending','cleanup_stalled')
    WHEN 'cleanup_stalled' THEN to_status = 'cleanup_pending'
    WHEN 'settled' THEN to_status = 'cleanup_pending'
    ELSE false
  END
$$;
