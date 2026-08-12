SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- One row per document version per prompt version, so the scan tracks document
-- volume multiplied by revision count. Its own migration: the scan runs in its
-- own transaction under SHARE UPDATE EXCLUSIVE, and a timeout here fails this
-- table alone and is retried by rerunning it.

ALTER TABLE "entity_version_ai_summaries" VALIDATE CONSTRAINT "entity_version_ai_summaries_workspace_organization_fk";
