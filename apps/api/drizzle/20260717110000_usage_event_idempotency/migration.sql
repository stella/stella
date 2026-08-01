SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint

-- Keep the migration additive across a mixed-version deploy: historical rows
-- and old API tasks leave idempotency_key NULL, while new tasks opt into the
-- uniqueness invariant. Build concurrently because the append-only ledger can
-- grow large and must remain writable while the index is created.
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
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "usage_events_org_idempotency_key_uidx"
  ON "usage_events" ("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
