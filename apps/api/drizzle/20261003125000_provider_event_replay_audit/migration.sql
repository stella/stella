SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_provider_webhook_events" ADD COLUMN "replay_audit" jsonb;

CREATE INDEX "usage_provider_webhook_events_ignored_entity_idx" ON "usage_provider_webhook_events" ((payload->'data'->>'id')) WHERE result = 'ignored';
CREATE INDEX "usage_provider_webhook_events_ignored_account_idx" ON "usage_provider_webhook_events" ((payload->'data'->>'account_ref')) WHERE result = 'ignored';
DROP INDEX "usage_provider_webhook_events_retention_idx";
CREATE INDEX "usage_provider_webhook_events_retention_idx" ON "usage_provider_webhook_events" (processed_at) WHERE result IN ('ok', 'ignored') AND (payload <> '{}'::jsonb OR error_message IS NOT NULL OR replay_audit @? '$[*] ? (exists(@.previousReason) || exists(@.reason) || exists(@.dispatchReason) || exists(@.event.metadata.reason) || exists(@.event.metadata.dispatchReason))'::jsonpath);
