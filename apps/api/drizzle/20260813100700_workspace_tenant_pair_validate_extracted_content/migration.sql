SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per document, each carrying that document's encrypted text, so this
-- is among the widest rows in the schema as well as one per corpus item. Its
-- own migration: the scan runs in its own transaction under SHARE UPDATE
-- EXCLUSIVE, and a timeout here fails this table alone and is retried by
-- rerunning it.

ALTER TABLE "extracted_content" VALIDATE CONSTRAINT "extracted_content_workspace_organization_fk";
