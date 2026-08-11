-- squawk-ignore-file constraint-missing-not-valid, adding-serial-primary-key-field, require-concurrent-index-creation
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - expands cleanup identity without deleting rows; transactional rollback restores the original primary key
ALTER TABLE "buffer_object_cleanup_intents"
  DROP CONSTRAINT "buffer_object_cleanup_intents_pkey";--> statement-breakpoint
-- Rebuilding the key is required to allow one cleanup intent per deterministic object.
-- The lock and statement timeouts above make contention fail fast.
ALTER TABLE "buffer_object_cleanup_intents"
  ADD CONSTRAINT "buffer_object_cleanup_intents_pkey"
  PRIMARY KEY ("id", "object_key");--> statement-breakpoint

-- Drizzle applies migrations transactionally, so CONCURRENTLY is unavailable.
-- The statement timeout above bounds the write-blocking interval.
CREATE INDEX "pending_uploads_email_ingest_recovery_idx"
  ON "pending_uploads" ("claimed_at", "id")
  WHERE "status" IN ('scanning', 'failed')
    AND "purpose" = 'email_ingest'
    AND jsonb_array_length(
      COALESCE("purpose_data"->'recoveryObjectKeys', '[]'::jsonb)
    ) > 0;--> statement-breakpoint
