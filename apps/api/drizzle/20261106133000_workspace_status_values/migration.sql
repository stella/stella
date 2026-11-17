SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_status_values_check" CHECK ("status" IN ('active', 'deleting', 'archived')) NOT VALID;
