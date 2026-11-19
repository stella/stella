SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The publisher snapshot day a bulk import source last finished reading:
-- its edition, which the coverage page will state. Additive: one nullable
-- column with no default rewrites no rows, and old API tasks never read it.
ALTER TABLE "case_law_sources" ADD COLUMN "import_snapshot_date" date;--> statement-breakpoint

-- The bulk importer records it once a run completes. Kept column-scoped.
-- The public reader's grant follows in the next release: this one only
-- permits it, so the release serving during that grant reads it as allowed.
GRANT SELECT ("import_snapshot_date"), UPDATE ("import_snapshot_date")
  ON TABLE "case_law_sources"
  TO stella_ingestion;
