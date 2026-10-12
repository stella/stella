-- requires: 20260813230000_document_processing_scoped_enqueue
-- requires: 20260830120000_signals
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- Build the bounded scheduled-work access path without blocking run writes.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- Retry rebuilds this new nonunique index after an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_scheduled_retry_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_scheduled_retry_idx"
  ON "document_processing_runs" ("next_attempt_at", "created_at", "id")
  WHERE "status" IN ('queued', 'failed') AND "next_attempt_at" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
ALTER TABLE document_processing_runs ADD COLUMN error_message text;
--> statement-breakpoint
ALTER TABLE document_processing_runs ADD COLUMN next_delivery_at timestamptz;
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - Restrict scoped native-extraction inserts to fresh requests with no worker-owned retry or error metadata; existing rows and worker writes remain unchanged. Rollback restores the prior insert predicate.
ALTER POLICY "document_processing_runs_native_extraction_insert"
  ON "document_processing_runs"
  WITH CHECK (((
    CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting(
            'app.workspace_ids', true
          )),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    )
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END AND organization_id =
    (SELECT current_setting(
      'app.organization_id', true
    ))
  ) AND (
    kind = 'native-extraction'
    AND request_source = 'upload'
    AND status = 'queued'
    AND requested_by IS NULL
    AND attempt_count = 0
    AND processor_version = 1
    AND progress_completed = 0
    AND progress_total IS NULL
    AND error_code IS NULL
    AND error_message IS NULL
    AND error_at IS NULL
    AND claimed_at IS NULL
    AND claimed_by IS NULL
    AND deadline_scout_attempt_count = 0
    AND deadline_scout_claimed_at IS NULL
    AND deadline_scout_error_code IS NULL
    AND deadline_scout_status = 'not_requested'
    AND next_attempt_at IS NULL
    AND next_delivery_at IS NULL
    AND started_at IS NULL
    AND finished_at IS NULL
    AND created_at = CURRENT_TIMESTAMP
    AND updated_at = CURRENT_TIMESTAMP
    AND EXISTS (
      SELECT 1
      FROM entities scoped_enqueue_entity
      INNER JOIN fields scoped_enqueue_field
        ON scoped_enqueue_field.id = document_processing_runs.field_id
        AND scoped_enqueue_field.workspace_id = document_processing_runs.workspace_id
        AND scoped_enqueue_field.entity_version_id = document_processing_runs.entity_version_id
      WHERE scoped_enqueue_entity.id = document_processing_runs.entity_id
        AND scoped_enqueue_entity.workspace_id = document_processing_runs.workspace_id
        AND scoped_enqueue_entity.current_version_id = document_processing_runs.entity_version_id
        AND scoped_enqueue_field.content->>'type' = 'file'
        AND scoped_enqueue_field.content->>'id' = document_processing_runs.source_file_id::text
        AND scoped_enqueue_field.content->>'sha256Hex' = document_processing_runs.source_sha256_hex
    )
  )));
