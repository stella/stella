SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only invalid remnants from this migration's concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_citing_page_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_citing_page_idx"
  ON "case_law_citations" ("citing_decision_id", "id");
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only invalid remnants from this migration's concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_cited_page_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_cited_page_idx"
  ON "case_law_citations" ("cited_decision_id", "id")
  WHERE "cited_decision_id" IS NOT NULL;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - the composite index above replaces this prefix index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_citing_idx";
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - the partial composite index above replaces this partial prefix index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_cited_idx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
