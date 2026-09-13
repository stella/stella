SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A published base cannot reconstruct the source of an existing Yjs snapshot.
-- Collaboration is undeployed. Adding a required column without a default
-- refuses existing rooms instead of rebinding saved paragraph tokens to a
-- different DOCX. Discard old test rooms before applying this clean cutover.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "folio_collab_rooms"
  ADD COLUMN "source_version_id" uuid NOT NULL;--> statement-breakpoint

ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_source_version_entity_workspace_fk"
  FOREIGN KEY ("source_version_id", "entity_id", "workspace_id")
  REFERENCES "entity_versions" ("id", "entity_id", "workspace_id") NOT VALID;
