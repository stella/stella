SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per assistant turn, so it grows several times faster than
-- chat_threads and is the largest chat table. Its own migration: the scan runs
-- in its own transaction under SHARE UPDATE EXCLUSIVE, and a timeout here
-- fails this table alone and is retried by rerunning this migration.

ALTER TABLE "chat_turns" VALIDATE CONSTRAINT "chat_turns_workspace_organization_fk";
