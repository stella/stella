SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle opens a transaction for migrations; PostgreSQL requires concurrent
-- index builds to run outside it. The MIME expression turns file-picker MIME
-- equality filters into indexed lookups without creating one index per type.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS could retain an INVALID index after an interrupted build
CREATE INDEX CONCURRENTLY "fields_workspace_file_mime_entity_version_id_idx"
  ON "fields" ("workspace_id", (("content"->>'mimeType')), "entity_version_id", "id")
  WHERE "content"->>'type' = 'file';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
