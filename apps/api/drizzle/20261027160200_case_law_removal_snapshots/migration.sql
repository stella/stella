SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_sitemap_shards"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_sitemap_shards"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
GRANT SELECT, DELETE ON "case_law_sitemap_shards" TO stella_ingestion;--> statement-breakpoint

CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_sitemap_shard_counts"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_sitemap_shard_counts"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
GRANT SELECT, DELETE ON "case_law_sitemap_shard_counts" TO stella_ingestion;--> statement-breakpoint

CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_browse_facet_counts"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_browse_facet_counts"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
GRANT SELECT, DELETE ON "case_law_browse_facet_counts" TO stella_ingestion;--> statement-breakpoint

CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_source_arrivals"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_source_arrivals"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
GRANT SELECT, DELETE ON "case_law_source_arrivals" TO stella_ingestion;--> statement-breakpoint

CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_coverage_summaries"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_coverage_summaries"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
GRANT SELECT, DELETE ON "case_law_coverage_summaries" TO stella_ingestion;--> statement-breakpoint

GRANT DELETE ON "case_law_citation_reviews" TO stella_ingestion;--> statement-breakpoint

ALTER TABLE "case_law_sources" ADD COLUMN "removal_checkpoint" jsonb;--> statement-breakpoint
GRANT SELECT ("removal_checkpoint"), UPDATE ("removal_checkpoint") ON "case_law_sources" TO stella_ingestion;
