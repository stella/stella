SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per passage per indexed entity: the tenant corpus multiplied by
-- passages per document, which makes this the largest table taking the pair
-- reference. Its own migration: the scan runs in its own transaction under
-- SHARE UPDATE EXCLUSIVE, and a timeout here fails this table alone and is
-- retried by rerunning it.

ALTER TABLE "search_document_preview_passages" VALIDATE CONSTRAINT "search_document_preview_passages_workspace_organization_fk";
