SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "playbook_definitions"
  ADD COLUMN "starter_id" varchar(64);
--> statement-breakpoint

-- Build the tenant-leading idempotency index without blocking playbook writes
-- while an existing deployment is upgraded.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - only an invalid
-- index left by a cancelled attempt at this migration is removed before retry.
DROP INDEX CONCURRENTLY IF EXISTS "playbook_definitions_org_starter_id_uidx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY "playbook_definitions_org_starter_id_uidx"
  ON "playbook_definitions" ("organization_id", "starter_id")
  WHERE "starter_id" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
