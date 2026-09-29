SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The names each stored legislation version's title states, for recognising
-- a query that names an act. Written per version from its stored title by
-- ingestion (and by an operator backfill for versions stored before), so it is
-- derived search data: no legislation row is changed by it.
--
-- A row is either the publisher's title exactly as stored (`official_title`)
-- or a derived name (`derived_name`) with the kind of derivation recorded,
-- never both. Created empty, so every constraint holds trivially.
CREATE TABLE IF NOT EXISTS "legislation_work_names" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_id" uuid NOT NULL,
  "country" varchar(3) NOT NULL,
  "official_title" text,
  "derived_name" text,
  "derivation" varchar(32),
  "cited_key" varchar(512),
  "match_key" varchar(512),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legislation_work_names_document_id_legislation_documents_id_fk"
    FOREIGN KEY ("document_id")
    REFERENCES "public"."legislation_documents"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "legislation_work_names_form_key"
    UNIQUE NULLS NOT DISTINCT ("document_id", "derivation", "cited_key", "match_key"),
  CONSTRAINT "legislation_work_names_official_or_derived"
    CHECK (("official_title" IS NOT NULL AND "derived_name" IS NULL AND "derivation" IS NULL) OR ("official_title" IS NULL AND "derived_name" IS NOT NULL AND "derivation" IS NOT NULL AND "match_key" IS NOT NULL)),
  CONSTRAINT "legislation_work_names_derivation_values"
    CHECK ("derivation" IS NULL OR "derivation" IN ('derived_title_segment','derived_parenthetical','derived_title_citation','derived_from_citation')),
  CONSTRAINT "legislation_work_names_cited_key_pairing"
    CHECK (("derivation" IS NOT DISTINCT FROM 'derived_from_citation') = ("cited_key" IS NOT NULL))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "legislation_work_names_match_key_idx"
  ON "legislation_work_names"
  USING btree ("match_key","country","derivation","cited_key","document_id")
  WHERE "match_key" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "legislation_work_names" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_work_names" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Row security is forced, so the owner-run backfill needs this policy; table
-- privileges decide which roles reach the rows.
-- stella-migration-safety: reviewed permissive-policy - privileges restrict the owner backfill, the ingestion writer and the public reader; the request role is revoked below
CREATE POLICY "legislation_work_name_owner_access" ON "legislation_work_names"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_work_names"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_work_names"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE "legislation_work_names" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "legislation_work_names"
  TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ("document_id", "country", "derivation", "cited_key", "match_key")
  ON TABLE "legislation_work_names"
  TO "stella_public_law_reader";
