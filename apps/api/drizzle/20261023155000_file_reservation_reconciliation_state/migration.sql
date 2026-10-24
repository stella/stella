SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "organization_file_objects"
  ADD COLUMN "reconciliation_state" text DEFAULT 'active' NOT NULL,
  ADD COLUMN "reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "reconcile_after" timestamptz;
--> statement-breakpoint

-- Touches only unresolved write rows through the existing partial
-- reconciliation index; the value derives from each row's own timestamp.
SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
UPDATE "organization_file_objects"
SET "reconcile_after" = "updated_at" + interval '5 minutes'
WHERE "write_id" IS NOT NULL;
--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
--> statement-breakpoint

-- Tasks still running the previous release write file objects without the
-- reconciliation columns. Fill them from write_id so every writer satisfies
-- the lifecycle check below: a resolved write leaves the sweep, and an
-- active write the writer left unscheduled is retried after the default
-- delay.
CREATE OR REPLACE FUNCTION "organization_file_objects_fill_reconciliation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.write_id IS NULL THEN
    NEW.reconciliation_state := 'active';
    NEW.reconciliation_attempt_count := 0;
    NEW.reconcile_after := NULL;
  ELSIF NEW.reconciliation_state = 'active' AND NEW.reconcile_after IS NULL THEN
    NEW.reconcile_after := now() + interval '5 minutes';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "organization_file_objects_fill_reconciliation"
  BEFORE INSERT OR UPDATE ON "organization_file_objects"
  FOR EACH ROW
  EXECUTE FUNCTION "organization_file_objects_fill_reconciliation"();
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

-- stella-migration-safety: reviewed drop-object - the active-only indexes
-- built above serve the same sweep; previous-release tasks still find
-- pending rows through them or a scan. Rollback rebuilds the index
-- concurrently from the previous migration's definition.
DROP INDEX CONCURRENTLY IF EXISTS "organization_file_objects_pending_reconcile_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - superseded by the
-- organization-scoped active index built above; rollback rebuilds it
-- concurrently from the previous migration's definition.
DROP INDEX CONCURRENTLY IF EXISTS "organization_file_objects_org_pending_reconcile_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
