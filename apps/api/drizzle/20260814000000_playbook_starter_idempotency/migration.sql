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

-- The migration runner validates this index after the ledger update and
-- concurrently repairs an interrupted INVALID build. IF NOT EXISTS preserves
-- an already-valid uniqueness boundary across retries.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "playbook_definitions_org_starter_id_uidx"
  ON "playbook_definitions" ("organization_id", "starter_id")
  WHERE "starter_id" IS NOT NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "playbook_definitions_org_starter_id_uidx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
