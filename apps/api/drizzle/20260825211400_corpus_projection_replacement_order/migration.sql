SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - this replaces only
-- the projection table's original epoch index before Plane introduces its
-- first producer; the transaction restores the old index on rollback.

-- The table is still inert until the projection executor ships; build the
-- recovery index before that launch so expired-lease scans stay bounded.
-- This projection table has no producer until the private runner ships after
-- this migration; the empty-table build cannot block corpus ingestion.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "corpus_index_projection_intents_expired_lease_idx"
  ON "corpus_index_projection_intents" (
    "family", "generation", "status", "lease_expires_at"
  )
  WHERE "status" IN ('reserved', 'append_started', 'cleanup_started');--> statement-breakpoint

-- Cleanup owns exact immutable revisions independently. Only phases that can
-- create or expose an append compete for the epoch's single append slot; this
-- lets a census reopen exact cleanup after a same-epoch retry is applied.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX "corpus_index_projection_intents_live_epoch_uidx";--> statement-breakpoint

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "corpus_index_projection_intents_append_epoch_uidx"
  ON "corpus_index_projection_intents" ("family", "generation", "entity_id", "epoch")
  WHERE "status" IN ('reserved', 'append_started', 'append_committed', 'applied');--> statement-breakpoint

-- A changed upsert must remove and settle the previous exact revision before
-- the replacement is appended. Desired-state drift already makes the entity
-- unavailable to readers, so this bounded omission is preferable to exposing
-- two physical revisions whose snippets may describe different text.
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
     ) THEN
    RAISE EXCEPTION 'current corpus index projection revision requires newer desired state before cleanup';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
