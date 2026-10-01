SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "prior_token_hash" text,
  ADD COLUMN IF NOT EXISTS "prior_token_expires_at" timestamptz;
--> statement-breakpoint
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "session_priorTokenHash_idx"
  ON "session" ("prior_token_hash");--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "session_priorTokenHash_idx";--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
