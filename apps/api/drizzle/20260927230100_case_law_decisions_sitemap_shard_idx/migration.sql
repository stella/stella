SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The sitemap refresh's access path: the public countries' published
-- decisions, counted per month and bucket with their newest update. Partial on the
-- publication gate, whose text matches `storedObservationHasDetail` exactly so
-- the planner proves the read's predicate implies it, and carrying every
-- column the count reads so it is an index-only scan rather than a heap and
-- TOAST read per decision.
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

-- Retry cleanup for this migration's own index: a cancelled concurrent build
-- can leave an INVALID index that would otherwise block recreation by name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_sitemap_shard_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_sitemap_shard_idx"
  ON "case_law_decisions" ("country", "decision_date", "source_id", "updated_at", "id")
  WHERE jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') is distinct from 'true';
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
