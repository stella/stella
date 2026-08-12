SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per judgment per topic per check kind: a single review run writes
-- many, so this table grows far faster than document_review_runs and is
-- validated apart from it. Its own migration: the scan runs in its own
-- transaction under SHARE UPDATE EXCLUSIVE, and a timeout here fails this
-- table alone and is retried by rerunning it.

ALTER TABLE "document_review_findings" VALIDATE CONSTRAINT "document_review_findings_workspace_organization_fk";
