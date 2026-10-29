-- requires: 20261028130000_ai_cell_settlements
SET lock_timeout = '1s';--> statement-breakpoint

-- Release the migration transaction before the online build. The index lets
-- a candidate-membership probe seek directly into one decision's work subtree.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_law_provision_citations_decision_work_subtree_idx"
  ON "case_law_provision_citations" ("decision_id", "jurisdiction", "work_identifier", "anchor" COLLATE "C", "span_start");
