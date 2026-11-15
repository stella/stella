SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The most a chat turn run on a member's computer may do without asking.
-- A constant default keeps every existing organization where it was (every
-- mode allowed) and rewrites no rows; nothing reads the column until this
-- release. The check is validated online after deployment
-- (local-run-approval-ceiling-constraint-validation.ts).
ALTER TABLE "organization_settings" ADD COLUMN "local_run_max_approval_mode" text DEFAULT 'full_auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_local_run_max_approval_mode_check" CHECK ("local_run_max_approval_mode" IN ('ask', 'auto', 'full_auto')) NOT VALID;
