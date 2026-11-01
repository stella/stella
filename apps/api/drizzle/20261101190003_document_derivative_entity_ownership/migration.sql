SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The product's permanent document deletion boundary owns every copied review
-- and bilingual payload. New writes and deletes obey both keys at once; the
-- online phase erases runs of documents deleted before this release, then
-- validates the keys.
ALTER TABLE "bilingual_translation_runs"
  ADD CONSTRAINT "bilingual_translation_runs_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "entities" ("id", "workspace_id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_review_runs"
  ADD CONSTRAINT "document_review_runs_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "entities" ("id", "workspace_id")
  ON DELETE CASCADE
  NOT VALID;
