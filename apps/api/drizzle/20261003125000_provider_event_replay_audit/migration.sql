SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_provider_webhook_events" ADD COLUMN IF NOT EXISTS "replay_audit" jsonb;

-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "usage_provider_webhook_events_ignored_entity_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "usage_provider_webhook_events_ignored_entity_idx" ON "usage_provider_webhook_events" ((payload->'data'->>'id')) WHERE result = 'ignored';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "usage_provider_webhook_events_ignored_account_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "usage_provider_webhook_events_ignored_account_idx" ON "usage_provider_webhook_events" ((payload->'data'->>'account_ref')) WHERE result = 'ignored';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "usage_provider_webhook_events_retention_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "usage_provider_webhook_events_retention_idx"
  ON "usage_provider_webhook_events" ("processed_at")
  WHERE result IN ('ok', 'ignored') AND (payload <> '{}'::jsonb OR error_message IS NOT NULL OR replay_audit @? '$[*] ? (exists(@.previousReason) || exists(@.reason) || exists(@.dispatchReason) || exists(@.event.metadata.reason) || exists(@.event.metadata.dispatchReason))'::jsonpath);
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
