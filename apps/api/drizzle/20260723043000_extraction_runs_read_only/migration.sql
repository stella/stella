SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - drops only app-role RLS policies and replaces them below with restrictive deny policies; rollback recreates the prior tenant-scoped policies
DROP POLICY "extraction_runs_workspace_insert" ON "extraction_runs";--> statement-breakpoint
DROP POLICY "extraction_runs_workspace_update" ON "extraction_runs";--> statement-breakpoint
DROP POLICY "extraction_runs_workspace_delete" ON "extraction_runs";--> statement-breakpoint
CREATE POLICY "extraction_runs_no_insert" ON "extraction_runs" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "extraction_runs_no_update" ON "extraction_runs" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "extraction_runs_no_delete" ON "extraction_runs" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
