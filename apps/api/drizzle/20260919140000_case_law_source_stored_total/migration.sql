SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- How many decisions the corpus holds per source, counted on the ingestion
-- side so a public request reads an integer instead of walking the source's
-- index range. Nullable: a source counted for the first time on its next
-- sync cycle reads as uncounted until then, never as holding nothing.
ALTER TABLE "case_law_sources" ADD COLUMN "stored_total" integer;--> statement-breakpoint
ALTER TABLE "case_law_sources" ADD COLUMN "stored_total_as_of" timestamp with time zone;--> statement-breakpoint

-- Validating CHECKs rather than NOT VALID: this table holds one row per
-- registered adapter, so the scan they cost is a few dozen rows.
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_stored_total_pair"
  CHECK (("stored_total" IS NULL) = ("stored_total_as_of" IS NULL));--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_stored_total_nonnegative"
  CHECK ("stored_total" IS NULL OR "stored_total" >= 0);--> statement-breakpoint

GRANT SELECT (stored_total, stored_total_as_of)
  ON TABLE "case_law_sources"
  TO stella_public_law_reader;
