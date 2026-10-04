-- requires: 20261003123500_configured_access
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_policies" VALIDATE CONSTRAINT "usage_policies_service_actions_positive";
--> statement-breakpoint
ALTER TABLE "organization_configured_access" VALIDATE CONSTRAINT "organization_configured_access_shape";
--> statement-breakpoint
ALTER TABLE "organization_configured_access" VALIDATE CONSTRAINT "organization_configured_access_source_status";
