SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build,
-- then restore and reopen a transaction for Drizzle's migration row.
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
DROP INDEX CONCURRENTLY IF EXISTS "pending_uploads_buffer_intent_recovery_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "pending_uploads_buffer_intent_recovery_idx"
  ON "pending_uploads" ("claimed_at", "id")
  WHERE "status" = 'scanning'
    AND "purpose" IN ('entity_create', 'entity_version')
    AND ("purpose_data"->>'reservedFileId') IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
