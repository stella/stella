SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "role" text;--> statement-breakpoint
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
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "properties_ws_document_type_classifier_unq" ON "properties" USING btree ("workspace_id") WHERE "role" = 'document-type-classifier';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
