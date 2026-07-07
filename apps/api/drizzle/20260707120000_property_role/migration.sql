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
-- stella-migration-safety: reviewed destructive-change - this drops only this
-- migration's partial index by name before recreating it below; retries must not
-- record the migration without the unique classifier invariant in place.
-- A cancelled concurrent index build can leave an INVALID index with this name.
-- Drop any leftover index first, then recreate without IF NOT EXISTS so retries
-- cannot record the migration without enforcing the invariant.
DROP INDEX CONCURRENTLY IF EXISTS "properties_ws_document_type_classifier_unq";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY "properties_ws_document_type_classifier_unq" ON "properties" USING btree ("workspace_id") WHERE "role" = 'document-type-classifier';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
