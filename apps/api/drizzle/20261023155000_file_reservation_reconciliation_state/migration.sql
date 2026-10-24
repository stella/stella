SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "organization_file_objects"
  ADD COLUMN "reconciliation_state" text DEFAULT 'active' NOT NULL,
  ADD COLUMN "reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "reconcile_after" timestamptz;
--> statement-breakpoint

-- stella-migration-safety: reviewed bulk-backfill - touches only unresolved
-- write rows through the existing partial reconciliation index; the value is
-- derived from each row's current retry timestamp and the statement is
-- idempotent under the migration transaction.
SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
UPDATE "organization_file_objects"
SET "reconcile_after" = "updated_at" + interval '5 minutes'
WHERE "write_id" IS NOT NULL;
--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "organization_file_objects"
  ADD CONSTRAINT "organization_file_objects_reconciliation_attempt_nonnegative"
    CHECK ("reconciliation_attempt_count" >= 0) NOT VALID,
  ADD CONSTRAINT "organization_file_objects_reconciliation_state_domain"
    CHECK ("reconciliation_state" IN ('active', 'quarantined')) NOT VALID,
  ADD CONSTRAINT "organization_file_objects_reconciliation_lifecycle"
    CHECK (
      (
        "write_id" IS NULL
        AND "reconciliation_state" = 'active'
        AND "reconciliation_attempt_count" = 0
        AND "reconcile_after" IS NULL
      ) OR (
        "write_id" IS NOT NULL
        AND (
          ("reconciliation_state" = 'active' AND "reconcile_after" IS NOT NULL)
          OR ("reconciliation_state" = 'quarantined' AND "reconcile_after" IS NULL)
        )
      )
    ) NOT VALID;
--> statement-breakpoint

SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
ALTER TABLE "organization_file_objects"
  VALIDATE CONSTRAINT "organization_file_objects_reconciliation_attempt_nonnegative",
  VALIDATE CONSTRAINT "organization_file_objects_reconciliation_state_domain",
  VALIDATE CONSTRAINT "organization_file_objects_reconciliation_lifecycle";
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

-- Only active rows enter the hot sweep. Quarantined rows retain their key,
-- write identity and byte reservation for explicit operator repair.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "organization_file_objects_active_reconcile_idx"
  ON "organization_file_objects" ("reconcile_after", "object_key")
  WHERE "write_id" IS NOT NULL AND "reconciliation_state" = 'active';
--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "organization_file_objects_org_active_reconcile_idx"
  ON "organization_file_objects" ("organization_id", "reconcile_after", "object_key")
  WHERE "write_id" IS NOT NULL AND "reconciliation_state" = 'active';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "organization_file_objects_pending_reconcile_idx";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "organization_file_objects_org_pending_reconcile_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
