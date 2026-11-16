SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "case_law_completeness_census" (
  "source_id" uuid NOT NULL REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "slice" varchar(64) NOT NULL,
  "year" integer,
  "outcome" text NOT NULL,
  "scope_status" text NOT NULL,
  "publisher_count" integer,
  "publisher_stated_count" integer,
  "enumerated_count" integer NOT NULL,
  "stored_count" integer NOT NULL,
  "text_count" integer NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "scope_first" varchar(64) NOT NULL,
  "scope_last" varchar(64) NOT NULL,
  "expected_slices" integer NOT NULL,
  "evidence_ref" text NOT NULL,
  PRIMARY KEY ("source_id", "slice"),
  CONSTRAINT "case_law_completeness_census_counts" CHECK (
    "stored_count" >= 0 AND "text_count" >= 0 AND "text_count" <= "stored_count" AND "expected_slices" > 0
    AND "enumerated_count" >= 0
    AND ("publisher_stated_count" IS NULL OR "publisher_stated_count" >= 0)
    AND "scope_status" IN ('full-publisher', 'partial-publisher')
    AND (("outcome" IN ('publisher-count', 'listing-enumerated', 'identity-unproven') AND "publisher_count" >= 0 AND "publisher_count" IS NOT NULL AND ("year" IS NOT NULL OR "slice" LIKE '0000%'))
      OR ("outcome" = 'none-exposed' AND "publisher_count" IS NULL))
    AND ("outcome" <> 'identity-unproven' OR "publisher_count" >= "enumerated_count")
    AND ("outcome" <> 'publisher-count' OR (
      "publisher_stated_count" IS NOT NULL
      AND "publisher_count" = "publisher_stated_count"
      AND "publisher_stated_count" >= "enumerated_count"
    ))
    AND ("outcome" <> 'listing-enumerated' OR (
      "publisher_count" = "enumerated_count"
      AND ("publisher_stated_count" IS NULL OR "publisher_stated_count" < "enumerated_count")
    ))
  )
);--> statement-breakpoint
CREATE INDEX "case_law_completeness_census_source_year_idx" ON "case_law_completeness_census" ("source_id", "year");--> statement-breakpoint
ALTER TABLE "case_law_completeness_census" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_completeness_census" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "census_owner_access" ON "case_law_completeness_census"
  FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_completeness_census'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_completeness_census'::regclass));--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_completeness_census" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_completeness_census" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_completeness_census"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (EXISTS (
    SELECT 1 FROM "case_law_sources" AS census_source
    WHERE census_source."id" = "case_law_completeness_census"."source_id"
      AND (census_source."descriptor" IS NULL
        OR (census_source."descriptor" ->> 'allowsRedistribution') = 'true')
  ));--> statement-breakpoint
-- Deploy the reader-grant expansion in #5968 before applying this migration.
-- Its running readers permit these columns while this release requires them.
GRANT SELECT ("source_id", "slice", "year", "outcome", "scope_status", "publisher_count",
  "stored_count", "text_count", "observed_at", "expected_slices", "evidence_ref")
  ON TABLE "case_law_completeness_census" TO "stella_public_law_reader";

--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_completeness_census" TO stella;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "case_law_completeness_census" TO stella_ingestion;
