SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The position and basis lifts kept their pre-lift columns as backups. Every
-- read path has moved to the lifted shapes, so the backups now only make the
-- migrated schema disagree with schema.ts.
-- stella-migration-safety: reviewed drop-column - no API task reads positions_v2 (schema.ts never declared it); the lifted positions column carries the same data, so rollback is a re-lift, not a restore
ALTER TABLE "playbook_definitions" DROP COLUMN IF EXISTS "positions_v2";--> statement-breakpoint
-- stella-migration-safety: reviewed drop-column - same backup column on the versions table; unread by every task and re-derivable from positions
ALTER TABLE "playbook_definition_versions" DROP COLUMN IF EXISTS "positions_v2";--> statement-breakpoint
-- stella-migration-safety: reviewed drop-column - basis_v1 was the pre-lift run basis backup; every task reads basis, and rollback re-lifts from it
ALTER TABLE "document_review_runs" DROP COLUMN IF EXISTS "basis_v1";--> statement-breakpoint

-- schema.ts pins the parties row to its workspace on its own as well as
-- through the composite tenant key; the create migration only wrote the latter.
ALTER TABLE "document_review_parties"
  ADD CONSTRAINT "document_review_parties_workspace_id_workspaces_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "document_review_parties"
  VALIDATE CONSTRAINT "document_review_parties_workspace_id_workspaces_id_fkey";
