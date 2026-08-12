SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per matter across every tenant, and the repair queue rewrites the
-- projection in bulk, so the scan competes with a background writer rather
-- than with ordinary traffic. Its own migration: the scan runs in its own
-- transaction under SHARE UPDATE EXCLUSIVE, and a timeout here fails this
-- table alone and is retried by rerunning it.

ALTER TABLE "workspace_search_documents" VALIDATE CONSTRAINT "workspace_search_documents_workspace_organization_fk";
