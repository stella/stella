-- requires: 20261027160200_case_law_removal_snapshots
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_sitemap_country_generations" (
  "country" varchar(3) PRIMARY KEY,
  "generation" bigint NOT NULL DEFAULT 0
);--> statement-breakpoint
ALTER TABLE "case_law_sitemap_country_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_sitemap_country_generations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_sitemap_generation_owner_access" ON "case_law_sitemap_country_generations"
  FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_sitemap_country_generations'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_sitemap_country_generations'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_sitemap_country_generations"
  FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON "case_law_sitemap_country_generations" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "case_law_sitemap_country_generations" TO stella_ingestion;
