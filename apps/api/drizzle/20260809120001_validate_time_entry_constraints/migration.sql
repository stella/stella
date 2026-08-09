SET lock_timeout = '1s';
--> statement-breakpoint
-- Validation scans the existing ledger without blocking normal reads or
-- writes. Its duration grows with retained time entries, so keep only the
-- lock timeout while allowing each scan to finish.
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "time_entries"
  VALIDATE CONSTRAINT "time_entries_work_item_workspace_fk";
--> statement-breakpoint
ALTER TABLE "time_entries"
  VALIDATE CONSTRAINT "time_entries_workspace_organization_fk";
--> statement-breakpoint
SET statement_timeout = '5s';
