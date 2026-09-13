SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The research-table retirement. A question column belongs to the
-- organization and its answers hang off the decision, so the saved search and
-- its per-row dispositions have no reader left: the routes went with the
-- results table, and the detach migration before this one cut the last
-- foreign key into them.
--
-- No data moves. Case law is feature-gated and these two relations held no
-- production rows; the questions and answers the organization keeps live in
-- "case_law_research_columns" and "case_law_research_answers", which this
-- migration leaves alone apart from the dead parent link.

-- stella-migration-safety: reviewed drop-object - one statement so the
-- composite foreign key between the two cannot order the drops wrongly.
-- Nothing reads either relation: the saved query and the pinned/excluded
-- dispositions were the retiring table view's alone. Their only grants are to
-- "stella", which the drop takes with them, so no REVOKE has to precede it.
-- Rollback is a redeploy of the previous image, which reads neither.
DROP TABLE IF EXISTS
  "case_law_research_table_decisions",
  "case_law_research_tables";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - the parent link the
-- organization-owned migration detached and the detach migration nulled. Its
-- foreign key ("clrc_table_org_fk") and its index ("clrc_table_position_idx")
-- are already gone, every row holds NULL, and the tables it pointed at no
-- longer exist. No reader resolves a column through a table; the previous
-- image writes NULL into it at most.
-- The columns table is bounded by the per-organization cap, so the ACCESS
-- EXCLUSIVE lock this metadata-only drop takes is capped by the lock_timeout
-- above.
ALTER TABLE "case_law_research_columns" DROP COLUMN IF EXISTS "table_id";
