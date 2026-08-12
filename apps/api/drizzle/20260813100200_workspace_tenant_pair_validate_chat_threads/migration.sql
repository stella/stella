SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per conversation, across every user of every tenant, so the scan
-- tracks chat use rather than tenant count. Its own migration: the scan runs
-- in its own transaction under SHARE UPDATE EXCLUSIVE, and a timeout here
-- fails this table alone and is retried by rerunning this migration.

ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_workspace_organization_fk";
