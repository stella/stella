-- Keep automatic OCR retry recovery and workspace sealing checks bounded.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_auto_failed_retry_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_running_workspace_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_entity_version_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only.
DROP INDEX CONCURRENTLY IF EXISTS "document_processing_runs_field_workspace_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_auto_failed_retry_idx"
  ON "document_processing_runs" ("next_attempt_at", "created_at", "id")
  WHERE "status" = 'failed' AND "request_source" IN ('upload', 'repair');
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_running_workspace_idx"
  ON "document_processing_runs" ("workspace_id", "id")
  WHERE "status" = 'running';
--> statement-breakpoint
-- Child-side indexes keep version and field cascade checks bounded as run
-- history grows.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_entity_version_idx"
  ON "document_processing_runs" ("entity_version_id");
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "document_processing_runs_field_workspace_idx"
  ON "document_processing_runs" ("field_id", "workspace_id");
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
