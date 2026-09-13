SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Finishes what the organization-owned migration started. A question column
-- is read by the organization now, but a legacy row still pointed at the
-- research table it was created under, through a composite foreign key that
-- cascades on delete: deleting one retiring table would have deleted questions
-- and the answers under them for every member of the organization. The link
-- is what has to go, not the delete route.
--
-- `table_id` itself stays for this deploy so a task still running the previous
-- image can write the column; it is dropped, with this nulling behind it, by
-- the research-table retirement migration.

-- stella-migration-safety: reviewed drop-constraint - the cascade this
-- constraint carried is the defect. No reader resolves a column through its
-- table any more: `readOrganizationResearchColumns` selects by organization,
-- and the retiring table view calls it too.
ALTER TABLE "case_law_research_columns"
  DROP CONSTRAINT IF EXISTS "clrc_table_org_fk";
--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the only access path built
-- for the table parent, and nothing selects on `table_id` now that the column
-- is being nulled. The organization's own path, `clrc_org_position_idx`,
-- serves every remaining read.
DROP INDEX IF EXISTS "clrc_table_position_idx";
--> statement-breakpoint

-- Bounded by the predicate and by the table: one row per question, a few per
-- organization, and rows already detached are skipped. Not a high-volume
-- table, so this runs inside the migration rather than as an online repair.
UPDATE "case_law_research_columns"
  SET "table_id" = NULL
  WHERE "table_id" IS NOT NULL;
