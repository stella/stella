-- Bound organization usage-overview date windows and per-user aggregation as
-- the append-only ledger grows.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- Existing events remain nullable and are displayed by model role; new events
-- record the resolved provider model ID.
ALTER TABLE "usage_events" ADD COLUMN "model_id" varchar(255);
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "usage_events_org_created_idx"
  ON "usage_events" ("organization_id", "created_at");
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "usage_events_org_user_created_idx"
  ON "usage_events" ("organization_id", "user_id", "created_at");
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
