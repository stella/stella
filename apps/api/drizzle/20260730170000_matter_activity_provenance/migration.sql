SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "audit_logs"
  ADD COLUMN "performer_type" text DEFAULT 'user' NOT NULL,
  ADD COLUMN "performer_id" text,
  ADD COLUMN "performer_name" text,
  ADD COLUMN "trigger_type" text DEFAULT 'direct' NOT NULL,
  ADD COLUMN "trigger_user_id" text,
  ADD COLUMN "trigger_source" text,
  ADD COLUMN "trigger_source_id" text,
  ADD COLUMN "run_id" text,
  ADD COLUMN "group_id" uuid,
  ADD COLUMN "approval_status" text DEFAULT 'not_required' NOT NULL,
  ADD COLUMN "approved_by_user_id" text,
  ADD COLUMN "activity_category" text;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_performer_type_check"
    CHECK ("performer_type" IN ('user', 'agent', 'service')),
  ADD CONSTRAINT "audit_logs_trigger_type_check"
    CHECK ("trigger_type" IN ('direct', 'user_dispatch', 'agent_delegation', 'schedule', 'webhook', 'credential', 'system')),
  ADD CONSTRAINT "audit_logs_approval_status_check"
    CHECK ("approval_status" IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD CONSTRAINT "audit_logs_activity_category_check"
    CHECK ("activity_category" IS NULL OR "activity_category" IN ('documents', 'tasks', 'matter', 'team', 'court', 'automation', 'other'));

CREATE INDEX "audit_logs_org_workspace_category_created_id_idx"
  ON "audit_logs" ("organization_id", "workspace_id", "activity_category", "created_at", "id");

CREATE INDEX "audit_logs_org_workspace_performer_created_id_idx"
  ON "audit_logs" ("organization_id", "workspace_id", "performer_type", "created_at", "id");

