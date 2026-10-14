-- requires: 20261014174500_case_law_citation_doctrine
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's partial doctrine index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_doctrine_cited_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_doctrine_cited_idx"
  ON "case_law_citations" ("cited_decision_id")
  WHERE "doctrinal_treatment" IN ('distinguishes', 'limits');--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
