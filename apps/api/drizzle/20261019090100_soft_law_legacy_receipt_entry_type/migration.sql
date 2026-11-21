-- requires: 20261004104100_soft_law_corpus
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Commit the prerequisite migration receipt before scanning retry receipts.
-- The JSONB update is idempotent, so an interrupted split can be replayed.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint
UPDATE "soft_law_ingestion_attempts"
SET "entry" = jsonb_set("entry", '{type}', '"document"', true)
WHERE "status" = 'retryable' AND "entry"->>'type' IS NULL;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';
