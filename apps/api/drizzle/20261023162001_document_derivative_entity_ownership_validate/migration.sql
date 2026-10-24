-- Validation scans run separately from the additive DDL lock. New writes and
-- deletes have already obeyed both constraints since the preceding migration.
ALTER TABLE "bilingual_translation_runs"
  VALIDATE CONSTRAINT "bilingual_translation_runs_entity_workspace_fk";
--> statement-breakpoint
ALTER TABLE "document_review_runs"
  VALIDATE CONSTRAINT "document_review_runs_entity_workspace_fk";
