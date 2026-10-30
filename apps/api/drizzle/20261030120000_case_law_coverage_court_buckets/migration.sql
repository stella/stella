SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_coverage_court_buckets" (
  "source_id" uuid NOT NULL,
  "rank" integer NOT NULL,
  "court" varchar(512),
  "total" integer NOT NULL,
  CONSTRAINT "case_law_coverage_court_buckets_pkey" PRIMARY KEY ("source_id", "rank"),
  CONSTRAINT "case_law_coverage_court_buckets_rank_positive" CHECK ("rank" > 0),
  CONSTRAINT "case_law_coverage_court_buckets_total_positive" CHECK ("total" > 0),
  CONSTRAINT "coverage_court_bucket_source_fk" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE
);--> statement-breakpoint

ALTER TABLE "case_law_coverage_court_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_coverage_court_buckets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_select" ON "case_law_coverage_court_buckets"
  FOR SELECT TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_removal_ingestion_delete" ON "case_law_coverage_court_buckets"
  FOR DELETE TO stella_ingestion USING (true);--> statement-breakpoint
CREATE POLICY "case_law_coverage_court_bucket_owner_access" ON "case_law_coverage_court_buckets"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_coverage_court_buckets'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_coverage_court_buckets'::regclass));--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_coverage_court_buckets"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (EXISTS (
    SELECT 1 FROM "case_law_sources" AS coverage_court_source
    WHERE coverage_court_source."id" = "case_law_coverage_court_buckets"."source_id"
      AND (coverage_court_source."descriptor" IS NULL OR (coverage_court_source."descriptor" ->> 'allowsRedistribution') = 'true')
  ));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_coverage_court_buckets" FROM stella;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "case_law_coverage_court_buckets" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("source_id", "rank", "court", "total") ON TABLE "case_law_coverage_court_buckets" TO "stella_public_law_reader";
