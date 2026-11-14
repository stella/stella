SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- An `append_committed` revision can now persist: lease-free, with the
-- publish barrier its recorded acceptance stored, until a presence proof
-- applies it. The shape keeps admitting the lease-held form without a
-- barrier, which a writer that applies in the acceptance's own transaction
-- still passes through, and `applied` no longer forbids a stored barrier.
-- Every other branch is unchanged. Replaced NOT VALID in the statement that
-- drops its predecessor; the online repair that already validates this
-- check validates it again, and every existing row satisfies the superset.
-- stella-migration-safety: reviewed drop-constraint - The same atomic statement replaces the status shape with a superset; every row and every existing writer satisfies it.
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
        ("lease_token" IS NULL) = ("append_publish_barrier_at" IS NOT NULL)
        AND "append_started_at" IS NOT NULL
        AND "append_committed_at" IS NOT NULL
        AND "applied_at" IS NULL
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

-- The online phase builds corpus_index_projection_intents_proof_idx (the
-- prover's claim over committed revisions by barrier) concurrently.
