-- requires: 20261005120500_feature_enrolments
-- requires: 20261005120400_verification_read_receipts
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- stella-migration-safety: reviewed delete-data - Remove document-owned runs whose parent no longer exists; dependent content cascades with them.
DELETE FROM "legal_list_verification_runs" AS run
WHERE NOT EXISTS (
  SELECT 1 FROM "entities" AS document
  WHERE document.id = run.entity_id AND document.workspace_id = run.workspace_id
);--> statement-breakpoint

ALTER TABLE "legal_list_verification_runs"
  ADD CONSTRAINT "legal_list_verification_runs_entity_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "entities" ("id", "workspace_id") ON DELETE CASCADE NOT VALID;
