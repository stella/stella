SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Access path for the point-in-time statute read. It seeks a Work by its
-- identifier and takes the latest window that opened on or before the
-- requested date; the existing identifier index stops at the identifier, so
-- every consolidation of a long-lived code would be fetched and sorted on an
-- unauthenticated path.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent
-- build, then restore and reopen a transaction for Drizzle's migration row.
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
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_eli_lang_valid_from_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_eli_lang_valid_from_idx"
  ON "legislation_documents" ("eli", "language", "version_valid_from");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
