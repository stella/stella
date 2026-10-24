SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "style_sets"
  ADD COLUMN "deletion_cleanup_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "deletion_cleanup_next_attempt_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "style_sets"
  ADD CONSTRAINT "style_sets_deletion_cleanup_attempt_count_nonnegative_check"
  CHECK ("deletion_cleanup_attempt_count" >= 0) NOT VALID;
--> statement-breakpoint

SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
ALTER TABLE "style_sets"
  VALIDATE CONSTRAINT "style_sets_deletion_cleanup_attempt_count_nonnegative_check";
--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
--> statement-breakpoint

-- Drizzle starts migrations in a transaction, but PostgreSQL requires a
-- concurrent index build outside one. Reopen the transaction afterward so
-- the migrator can record this migration atomically.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "style_sets_deletion_cleanup_idx";
--> statement-breakpoint
-- A soft-deleted style set is the durable storage-cleanup receipt. The
-- recurring worker walks only those outstanding receipts in deletion order.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "style_sets_deletion_cleanup_idx"
  ON "style_sets" (
    "deletion_cleanup_attempt_count",
    "deleted_at",
    "id"
  )
  WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "style_sets_pending_package_cleanup_idx";
--> statement-breakpoint
-- Replacement cleanup and deletion cleanup have distinct owners. Keep this
-- queue index on active rows; deleted rows are consumed by the tombstone walk.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "style_sets_pending_package_cleanup_idx"
  ON "style_sets" ("updated_at", "id")
  WHERE "cleanup_s3_key" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
