-- requires: 20261117150000_case_law_source_import_snapshot
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The coverage page and the corpus status state a bulk import source's
-- edition: the publisher snapshot its last completed run read. The previous
-- release permits this grant, so the release serving during it accepts it.
GRANT SELECT ("import_snapshot_date")
  ON TABLE "case_law_sources"
  TO stella_public_law_reader;
