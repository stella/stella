SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "legislation_facet_counts" (
  "country" varchar(3) NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "legislation_sources"("id") ON DELETE CASCADE,
  "document_type" varchar(128) NOT NULL,
  "works" integer NOT NULL,
  CONSTRAINT "legislation_facet_counts_pkey" PRIMARY KEY ("country", "source_id", "document_type"),
  CONSTRAINT "legislation_facet_counts_works_positive" CHECK ("works" > 0)
);--> statement-breakpoint

ALTER TABLE "legislation_facet_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_facet_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The owner refresh needs a policy under forced row security. Table privileges
-- keep the request role out and expose only the listed columns to readers.
CREATE POLICY "legislation_facet_count_owner_access" ON "legislation_facet_counts"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_counts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legislation_facet_counts'::regclass));--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_facet_counts"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (EXISTS (
    SELECT 1 FROM "legislation_sources" AS facet_source
    WHERE facet_source."id" = "legislation_facet_counts"."source_id"
      AND (
        facet_source."descriptor" IS NULL
        OR (facet_source."descriptor" ->> 'allowsRedistribution') = 'true'
      )
  ));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "legislation_facet_counts" FROM stella;--> statement-breakpoint
GRANT SELECT ("country", "source_id", "document_type", "works")
  ON TABLE "legislation_facet_counts"
  TO "stella_public_law_reader";--> statement-breakpoint

CREATE TABLE "case_law_source_arrivals" (
  "source_id" uuid PRIMARY KEY NOT NULL REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "added_last_week" integer NOT NULL,
  "counted_at" timestamp with time zone NOT NULL,
  CONSTRAINT "case_law_source_arrivals_added_nonnegative" CHECK ("added_last_week" >= 0)
);--> statement-breakpoint

ALTER TABLE "case_law_source_arrivals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_source_arrivals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_source_arrival_owner_access" ON "case_law_source_arrivals"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_source_arrivals'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_source_arrivals'::regclass));--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_source_arrivals"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (EXISTS (
    SELECT 1 FROM "case_law_sources" AS arrival_source
    WHERE arrival_source."id" = "case_law_source_arrivals"."source_id"
      AND (
        arrival_source."descriptor" IS NULL
        OR (arrival_source."descriptor" ->> 'allowsRedistribution') = 'true'
      )
  ));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_source_arrivals" FROM stella;--> statement-breakpoint
GRANT SELECT ("source_id", "added_last_week", "counted_at")
  ON TABLE "case_law_source_arrivals"
  TO "stella_public_law_reader";
