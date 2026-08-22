-- squawk-ignore-file constraint-missing-not-valid, adding-serial-primary-key-field
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - expands cleanup identity without deleting rows; transactional rollback restores the original primary key
ALTER TABLE "buffer_object_cleanup_intents"
  DROP CONSTRAINT "buffer_object_cleanup_intents_pkey";--> statement-breakpoint
-- Rebuilding the key is required to allow one cleanup intent per deterministic object.
-- The lock and statement timeouts above make contention fail fast.
ALTER TABLE "buffer_object_cleanup_intents"
  ADD CONSTRAINT "buffer_object_cleanup_intents_pkey"
  PRIMARY KEY ("id", "object_key");--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Commit the primary-key change first, lift the timeouts for the concurrent
-- build, then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, which IF NOT EXISTS would preserve.
DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_email_ingest_recovery_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "pending_uploads_email_ingest_recovery_idx"
  ON "pending_uploads" ("claimed_at", "id")
  WHERE "status" IN ('scanning', 'failed')
    AND "purpose" = 'email_ingest'
    AND jsonb_array_length(
      COALESCE("purpose_data"->'recoveryObjectKeys', '[]'::jsonb)
    ) > 0;--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
