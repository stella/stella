SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  VALIDATE CONSTRAINT "document_translation_runs_ai_source_presence_check";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - The validated replacement preserves non-null AI sources while allowing provider auto-detection; existing explicit-source tasks remain valid.
ALTER TABLE "document_translation_runs"
  DROP CONSTRAINT "document_translation_runs_ai_source_lang_check";
