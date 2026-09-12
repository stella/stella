SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A question column belongs to the organization, not to a research table: that
-- is what lets one answer serve every search that surfaces the decision. This
-- migration is additive only. `table_id` keeps its rows and its foreign key so
-- the retiring research-table routes still read what they wrote; a column
-- created from the results table simply has none. Dropping the column and its
-- constraint is a later migration, once this deploy is out.
-- squawk-ignore ban-drop-not-null -- an organization column has no parent table by design; the only reader of table_id is the retiring research-table view, which selects by a non-null id
ALTER TABLE "case_law_research_columns" ALTER COLUMN "table_id" DROP NOT NULL;
--> statement-breakpoint

-- Who asked the question. The organization owns the column, so attribution is
-- all this records: ON DELETE SET NULL matches every other attribution column
-- in the schema, where RESTRICT would let a question outvote account deletion.
ALTER TABLE "case_law_research_columns" ADD COLUMN "created_by" text;
--> statement-breakpoint

ALTER TABLE "case_law_research_columns"
  ADD CONSTRAINT "clrc_created_by_fk"
  FOREIGN KEY ("created_by") REFERENCES "user" ("id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- the statement above added the column, so every existing row holds NULL and the validating scan has nothing to read
ALTER TABLE "case_law_research_columns" VALIDATE CONSTRAINT "clrc_created_by_fk";
--> statement-breakpoint

-- Access path for the only list there is now: the organization's columns in
-- display order. Built inside the migrator's transaction rather than
-- concurrently because the table is bounded by the per-organization column cap
-- (20 rows per tenant, a few thousand across the deployment), so the ACCESS
-- EXCLUSIVE lock lasts milliseconds and is capped by the lock_timeout above.
-- squawk-ignore require-concurrent-index-creation -- bounded table: at most 20 rows per organization, see the comment above
CREATE INDEX "clrc_org_position_idx" ON "case_law_research_columns" USING btree ("organization_id", "position", "id");
