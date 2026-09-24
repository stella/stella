SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `case_law_provision_citations_decision_idx` is a leading prefix of the
-- unique `(decision_id, span_start, anchor)` index, which serves every lookup
-- by decision (the per-decision read, the cascade from the decision, the
-- writer's own reads) and already orders them. Keeping both only doubles the
-- maintenance on every insert.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires DROP INDEX CONCURRENTLY to run outside a transaction block. Split
-- the migrator transaction, lift the statement budget for the concurrent drop,
-- then restore and reopen a transaction for Drizzle's migration row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a strict prefix of the unique index on the same table, so no read loses its access path; rollback recreates it with CREATE INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_provision_citations_decision_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
