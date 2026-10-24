SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

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
SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
-- stella-migration-safety: reviewed delete-data - entities never change
-- workspace and entity_id is NOT NULL, so only runs of permanently deleted
-- documents match; their erasure is the intent and is not rolled back.
DELETE FROM "bilingual_translation_runs" AS run
WHERE NOT EXISTS (
  SELECT 1
  FROM "entities" AS entity
  WHERE entity."id" = run."entity_id"
    AND entity."workspace_id" = run."workspace_id"
);
--> statement-breakpoint
-- stella-migration-safety: reviewed delete-data - same orphan rule as above:
-- only review runs of permanently deleted documents match, and their
-- erasure is the intent.
DELETE FROM "document_review_runs" AS run
WHERE NOT EXISTS (
  SELECT 1
  FROM "entities" AS entity
  WHERE entity."id" = run."entity_id"
    AND entity."workspace_id" = run."workspace_id"
);
