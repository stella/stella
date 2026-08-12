SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per indexed entity, so the scan tracks the whole tenant corpus. Its
-- own migration: the scan runs in its own transaction under SHARE UPDATE
-- EXCLUSIVE, and a timeout here fails this table alone and is retried by
-- rerunning it.

ALTER TABLE "search_documents" VALIDATE CONSTRAINT "search_documents_workspace_organization_fk";
