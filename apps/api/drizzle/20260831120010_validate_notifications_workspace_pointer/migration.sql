SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "notifications"
  VALIDATE CONSTRAINT "notifications_workspace_id_workspaces_id_fk";
