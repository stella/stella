-- requires: 20261005120500_feature_enrolments
-- requires: 20261005120400_verification_read_receipts
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- stella-migration-safety: reviewed delete-data - Remove document-owned runs whose parent no longer exists; dependent content cascades with them.
-- stella-migration-safety: reviewed insert-select - writes one audit row per run deleted by the same statement.
WITH removed_runs AS (
  DELETE FROM "legal_list_verification_runs" AS run
  WHERE NOT EXISTS (
    SELECT 1 FROM "entities" AS document
    WHERE document.id = run.entity_id AND document.workspace_id = run.workspace_id
  )
  RETURNING run.id, run.organization_id, run.workspace_id, run.entity_id, run.requested_by
)
INSERT INTO "audit_logs" (
  "id",
  "organization_id",
  "workspace_id",
  "user_id",
  "action",
  "resource_type",
  "resource_id",
  "metadata",
  "changes",
  "performer_type",
  "performer_id",
  "performer_name",
  "trigger_type",
  "trigger_source",
  "trigger_source_id",
  "activity_category"
)
SELECT
  md5('20261005120600_verification_document_cascade:' || removed_runs.id::text)::uuid,
  removed_runs.organization_id,
  removed_runs.workspace_id,
  coalesce(removed_runs.requested_by, 'database-migration'),
  'delete',
  'legal_list_verification_run',
  removed_runs.id::text,
  jsonb_build_object('cause', 'document_missing'),
  jsonb_build_object(
    'deleted', jsonb_build_object(
      'old', jsonb_build_object('entityId', removed_runs.entity_id),
      'new', NULL
    )
  ),
  'service',
  'database-migration',
  'Verification history repair',
  'system',
  'database_migration',
  '20261005120600_verification_document_cascade',
  'team'
FROM removed_runs;--> statement-breakpoint

ALTER TABLE "legal_list_verification_runs"
  ADD CONSTRAINT "legal_list_verification_runs_entity_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "entities" ("id", "workspace_id") ON DELETE CASCADE NOT VALID;
