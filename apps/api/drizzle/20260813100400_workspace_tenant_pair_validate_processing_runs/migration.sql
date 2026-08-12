SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per OCR or native-extraction pass over a document, and a document
-- can be reprocessed, so the scan tracks document volume. Its own migration:
-- the scan runs in its own transaction under SHARE UPDATE EXCLUSIVE, and a
-- timeout here fails this table alone and is retried by rerunning it.

ALTER TABLE "document_processing_runs" VALIDATE CONSTRAINT "document_processing_runs_workspace_organization_fk";
