SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Constant defaults use the catalog fast path; existing rows are not rewritten.
-- The online phase schedules existing unresolved writes (reconcile_after) and
-- then validates the checks below.
ALTER TABLE "organization_file_objects"
  ADD COLUMN "reconciliation_state" text DEFAULT 'active' NOT NULL,
  ADD COLUMN "reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "reconcile_after" timestamptz;
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
