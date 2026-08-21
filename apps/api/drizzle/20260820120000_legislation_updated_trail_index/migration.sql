SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The bounded updated-row walk keysets and orders by (updated_at, id).
-- Build its matching access path without blocking writes.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - this retry cleanup
-- targets only this migration's index; a cancelled concurrent build can leave
-- an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_updated_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_updated_id_idx"
  ON "legislation_documents" ("updated_at", "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
