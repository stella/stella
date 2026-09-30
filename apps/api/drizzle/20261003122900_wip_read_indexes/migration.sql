-- requires: 20261003122800_time_entry_activity_groups
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- Replayable partial indexes keep WIP reads off billed history.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_org_workspace_wip_idx" ON "time_entries" ("organization_id", "workspace_id", "date_worked") WHERE "activity_group" = 'client' AND "status" = 'approved' AND "invoice_id" IS NULL AND "billable" AND NOT "no_charge";
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "time_entries_org_workspace_wip_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses_org_workspace_wip_idx" ON "expenses" ("organization_id", "workspace_id", "date_incurred") WHERE "invoice_id" IS NULL AND "billable" AND "status" IN ('draft', 'approved');
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "expenses_org_workspace_wip_idx";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
