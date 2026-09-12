SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Better Auth 1.7.3 identifies accounts by (provider_id, account_id). Establish
-- that key before retiring the old identity constraints: a collision stops the
-- migration without merging accounts or relaxing the old schema. The unique
-- build also covers writes racing the scan; a separate preflight would not.
-- Release the transaction for concurrent index work on the write-hot table.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "account_provider_account_id_uidx"
  ON "account" ("provider_id", "account_id");--> statement-breakpoint
-- A failed concurrent build can leave an INVALID index. IF NOT EXISTS alone
-- cannot prove uniqueness on retry; repair it before dropping the old key.
REINDEX INDEX CONCURRENTLY "account_provider_account_id_uidx";--> statement-breakpoint
-- The online migration phase validates the new index definition and validity
-- before retiring account_issuer_account_id_uidx. A successful statement alone
-- does not establish that an existing same-named index has the expected key.
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Preserve historical data, but permit the new version to omit issuer. Old
-- runtimes cannot look up these new NULL-issuer rows: auth traffic must stay
-- paused until every old instance is drained. See docs/better-auth-173-cutover.md.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
