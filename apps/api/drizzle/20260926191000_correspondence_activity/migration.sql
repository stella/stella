SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replacing the category check with a superset; existing rows remain valid.
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_activity_category_check";--> statement-breakpoint
-- NOT VALID avoids scanning the populated audit log during deployment.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_activity_category_check"
  CHECK ("activity_category" IS NULL OR "activity_category" IN ('documents', 'tasks', 'matter', 'team', 'court', 'automation', 'correspondence', 'other')) NOT VALID;--> statement-breakpoint
