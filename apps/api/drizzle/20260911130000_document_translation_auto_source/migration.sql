SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_ai_source_presence_check"
  CHECK ("engine" <> 'ai' OR "source_lang" IS NOT NULL) NOT VALID;
