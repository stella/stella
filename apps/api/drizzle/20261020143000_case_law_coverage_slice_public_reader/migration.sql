GRANT SELECT ("source_id", "slice", "reported", "collected", "checked_at", "walk_error")
  ON TABLE "case_law_coverage_slices" TO "stella_public_law_reader";--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_coverage_slices"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
