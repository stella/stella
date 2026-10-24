-- The product's permanent document deletion boundary owns every copied review
-- and bilingual payload. Existing orphan runs predate that invariant and must
-- be erased before the constraints can be validated.
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
--> statement-breakpoint
DELETE FROM "bilingual_translation_runs" AS run
WHERE NOT EXISTS (
  SELECT 1
  FROM "entities" AS entity
  WHERE entity."id" = run."entity_id"
    AND entity."workspace_id" = run."workspace_id"
);
--> statement-breakpoint
DELETE FROM "document_review_runs" AS run
WHERE NOT EXISTS (
  SELECT 1
  FROM "entities" AS entity
  WHERE entity."id" = run."entity_id"
    AND entity."workspace_id" = run."workspace_id"
);
