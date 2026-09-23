SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The statute listing can be narrowed to one kind of act. It walks a
-- jurisdiction newest consolidation first and stops at the page limit, which
-- `legislation_documents_country_valid_from_id_idx` serves only while most
-- rows match: a rare kind (`ústavní zákon`, a few hundred rows of the Czech
-- corpus) turns the walk into a scan of the jurisdiction. The type after the
-- country keeps the narrowed walk an index range read backwards.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build
-- (which takes no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260901130000_legislation_title_fold.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drops only this migration's own index by name before recreating it. A
-- cancelled concurrent build leaves an INVALID index behind, and IF NOT
-- EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_type_valid_from_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_country_type_valid_from_id_idx"
  ON "legislation_documents" ("country", "document_type", coalesce("version_valid_from", DATE '0001-01-01'), "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
