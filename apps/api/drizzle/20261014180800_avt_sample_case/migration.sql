-- requires: 20260808014000_legal_lists
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_lists" ADD COLUMN IF NOT EXISTS "sample_case" jsonb;--> statement-breakpoint

-- Split the migrator transaction for a non-blocking sample receipt index.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- IF NOT EXISTS keeps a valid uniqueness boundary across retries; the
-- concurrent rebuild repairs a build a previous attempt left INVALID.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "legal_lists_sample_workspace_uidx" ON "legal_lists" ("workspace_id") WHERE "sample_case" IS NOT NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "legal_lists_sample_workspace_uidx";
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
