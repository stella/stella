SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- Passages per matter, rewritten in bulk by the same repair queue that feeds
-- workspace_search_documents, so it is both larger than its parent and subject
-- to the same background writer. Its own migration: the scan runs in its own
-- transaction under SHARE UPDATE EXCLUSIVE, and a timeout here fails this
-- table alone and is retried by rerunning it.

ALTER TABLE "workspace_search_document_preview_passages" VALIDATE CONSTRAINT "workspace_search_document_preview_passages_workspace_org_fk";
