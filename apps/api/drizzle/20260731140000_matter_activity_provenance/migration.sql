-- Additive audit provenance. Every column has a rollout-safe default or stays
-- nullable so old API tasks remain compatible while the new code deploys.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- IF NOT EXISTS keeps replay safe if a later concurrent index build is
-- interrupted after these transactional changes commit.
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "performer_type" text DEFAULT 'user' NOT NULL,
  ADD COLUMN IF NOT EXISTS "performer_id" text,
  ADD COLUMN IF NOT EXISTS "performer_name" text,
  ADD COLUMN IF NOT EXISTS "trigger_type" text DEFAULT 'direct' NOT NULL,
  ADD COLUMN IF NOT EXISTS "trigger_user_id" text,
  ADD COLUMN IF NOT EXISTS "trigger_source" text,
  ADD COLUMN IF NOT EXISTS "trigger_source_id" text,
  ADD COLUMN IF NOT EXISTS "run_id" text,
  ADD COLUMN IF NOT EXISTS "group_id" uuid,
  ADD COLUMN IF NOT EXISTS "approval_status" text DEFAULT 'not_required' NOT NULL,
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "activity_category" text;
--> statement-breakpoint

-- NOT VALID avoids scanning and locking the append-only history during the
-- deploy. PostgreSQL still enforces these checks for every new row; all legacy
-- rows receive the safe defaults above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_performer_type_check'
      AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_performer_type_check"
      CHECK ("performer_type" IN ('user', 'agent', 'service')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_trigger_type_check'
      AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_trigger_type_check"
      CHECK ("trigger_type" IN ('direct', 'user_dispatch', 'agent_delegation', 'schedule', 'webhook', 'credential', 'system')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_approval_status_check'
      AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approval_status_check"
      CHECK ("approval_status" IN ('not_required', 'pending', 'approved', 'rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_activity_category_check'
      AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_activity_category_check"
      CHECK ("activity_category" IS NULL OR "activity_category" IN ('documents', 'tasks', 'matter', 'team', 'court', 'automation', 'other')) NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint

-- Drizzle wraps migrations in a transaction, while PostgreSQL requires
-- concurrent index builds to run outside one. Reopen a transaction afterward
-- so Drizzle can record the migration atomically.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup only;
-- an interrupted concurrent build can leave this migration's index invalid.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_org_workspace_category_created_id_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only;
-- an interrupted concurrent build can leave this migration's index invalid.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_org_workspace_performer_created_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "audit_logs_org_workspace_category_created_id_idx"
  ON "audit_logs" ("organization_id", "workspace_id", "activity_category", "created_at", "id");
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "audit_logs_org_workspace_performer_created_id_idx"
  ON "audit_logs" ("organization_id", "workspace_id", "performer_type", "created_at", "id");
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
