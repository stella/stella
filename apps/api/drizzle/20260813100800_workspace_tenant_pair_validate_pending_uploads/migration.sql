SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per upload reservation, kept after finalization, so the table
-- accumulates with every file ever uploaded rather than with the files that
-- currently exist. Its own migration: the scan runs in its own transaction
-- under SHARE UPDATE EXCLUSIVE, and a timeout here fails this table alone and
-- is retried by rerunning it.

ALTER TABLE "pending_uploads" VALIDATE CONSTRAINT "pending_uploads_workspace_organization_fk";
