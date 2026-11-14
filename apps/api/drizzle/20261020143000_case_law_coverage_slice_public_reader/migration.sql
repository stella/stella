SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

GRANT SELECT ("source_id", "slice", "reported", "collected", "checked_at")
  ON TABLE "case_law_coverage_slices" TO "stella_public_law_reader";--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_coverage_slices"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
