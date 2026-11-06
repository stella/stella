SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A time entry can now wait in `submitted` between draft and approved. The
-- status column is free text bounded by the application, so only the internal
-- entry shape check names statuses; it is widened to accept `submitted`.
-- stella-migration-safety: reviewed drop-constraint - the check is immediately replaced by a wider NOT VALID check that also accepts the submitted status; every existing row still satisfies it, and it is validated online.
ALTER TABLE "time_entries" DROP CONSTRAINT IF EXISTS "time_entries_internal_shape_check";--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_internal_shape_check"
  CHECK ("activity_group" <> 'internal' OR (
    "workspace_id" IS NULL AND "billable" = false AND "no_charge" = false
    AND "billed_minutes" = 0 AND "rate_at_entry" = 0 AND "currency" = 'XXX'
    AND "invoice_id" IS NULL AND "work_item_id" IS NULL
    AND "task_code" IS NULL AND "activity_code" IS NULL AND "invoice_narrative" IS NULL
    AND "status" IN ('draft', 'submitted', 'approved'))) NOT VALID;
