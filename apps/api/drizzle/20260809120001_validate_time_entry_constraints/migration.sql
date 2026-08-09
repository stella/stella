SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "time_entries"
  VALIDATE CONSTRAINT "time_entries_work_item_workspace_fk";
--> statement-breakpoint
ALTER TABLE "time_entries"
  VALIDATE CONSTRAINT "time_entries_workspace_organization_fk";
