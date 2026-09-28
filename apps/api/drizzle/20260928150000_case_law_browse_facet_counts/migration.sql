SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_browse_facet_counts" (
  "kind" text NOT NULL,
  "country" varchar(3) NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "value" varchar(512) NOT NULL,
  "total" integer NOT NULL,
  CONSTRAINT "case_law_browse_facet_counts_pkey" PRIMARY KEY ("kind", "country", "source_id", "value"),
  CONSTRAINT "case_law_browse_facet_counts_total_positive" CHECK ("total" > 0),
  CONSTRAINT "case_law_browse_facet_counts_kind_valid" CHECK ("kind" IN ('country', 'court', 'year'))
);--> statement-breakpoint

ALTER TABLE "case_law_browse_facet_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_browse_facet_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The owner refresh needs a policy under forced row security. Table privileges
-- keep the request role out and expose only the listed columns to readers.
CREATE POLICY "case_law_browse_facet_count_owner_access" ON "case_law_browse_facet_counts"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_browse_facet_counts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_browse_facet_counts'::regclass));--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_browse_facet_counts"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (EXISTS (
    SELECT 1 FROM "case_law_sources" AS browse_facet_source
    WHERE browse_facet_source."id" = "case_law_browse_facet_counts"."source_id"
      AND (
        browse_facet_source."descriptor" IS NULL
        OR (browse_facet_source."descriptor" ->> 'allowsRedistribution') = 'true'
      )
  ));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_browse_facet_counts" FROM stella;--> statement-breakpoint
GRANT SELECT ("kind", "country", "source_id", "value", "total")
  ON TABLE "case_law_browse_facet_counts"
  TO "stella_public_law_reader";
