-- requires: 20261028130000_ai_cell_settlements
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Build the index outside the migration transaction so the scan holds no
-- DDL locks. It lets a candidate-membership probe seek directly into one
-- decision's work subtree.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_law_provision_citations_decision_work_subtree_idx"
  ON "case_law_provision_citations" ("decision_id", "jurisdiction", "work_identifier", "anchor" COLLATE "C", "span_start");
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "case_law_provision_citations_decision_work_subtree_idx";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
