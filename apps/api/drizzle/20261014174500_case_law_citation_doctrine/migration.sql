SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_citations" ADD COLUMN "doctrinal_treatment" varchar(16);--> statement-breakpoint
-- Derived from DOCTRINAL_TREATMENTS; null means unread.
ALTER TABLE "case_law_citations" ADD CONSTRAINT "citations_doctrinal_treatment_values"
  CHECK ("doctrinal_treatment" IN ('distinguishes', 'limits', 'not_stated')) NOT VALID;--> statement-breakpoint

-- A reviewed doctrinal action per (citing decision, citation key). Citation rows are
-- re-inserted under new ids on every refresh of the citing decision, so the
-- review is keyed on what survives the refresh.
CREATE TABLE "case_law_citation_doctrine_reviews" (
  "id" uuid PRIMARY KEY NOT NULL,
  "citing_decision_id" uuid NOT NULL,
  "citation_key" varchar(128) NOT NULL,
  "doctrinal_treatment" varchar(16) NOT NULL,
  "evidence_quote" text,
  "origin" text NOT NULL,
  "model" text,
  "prompt_version" text,
  "prompt_sha256" varchar(64),
  "evidence_sha256" varchar(64),
  "run_id" text,
  "produced_at" timestamptz,
  "review_ref" varchar(200) NOT NULL,
  "reviewed_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_citation_doctrine_reviews_citing_decision_fk"
    FOREIGN KEY ("citing_decision_id")
    REFERENCES "case_law_decisions"("id")
    ON DELETE CASCADE,
  -- Derived from DOCTRINAL_TREATMENTS.
  CONSTRAINT "citation_doctrine_reviews_treatment_values"
    CHECK ("doctrinal_treatment" IN ('distinguishes', 'limits', 'not_stated')),
  CONSTRAINT "citation_doctrine_reviews_citation_key_non_empty"
    CHECK ("citation_key" <> ''),
  CONSTRAINT "citation_doctrine_reviews_review_ref_non_empty"
    CHECK ("review_ref" <> ''),
  CONSTRAINT "citation_doctrine_reviews_origin_values"
    CHECK ("origin" IN ('human-review', 'ai-adjudicated', 'ai-annotation')),
  CONSTRAINT "citation_doctrine_reviews_origin_provenance"
    CHECK (
      ("origin" IN ('human-review')
        AND "model" IS NULL AND "prompt_version" IS NULL
        AND "prompt_sha256" IS NULL AND "evidence_sha256" IS NULL
        AND "run_id" IS NULL AND "produced_at" IS NULL)
      OR ("origin" IN ('ai-adjudicated', 'ai-annotation')
        AND "model" IS NOT NULL AND "prompt_version" IS NOT NULL
        AND "prompt_sha256" IS NOT NULL AND "evidence_sha256" IS NOT NULL
        AND "run_id" IS NOT NULL AND "produced_at" IS NOT NULL)
    ),
  CONSTRAINT "citation_doctrine_reviews_evidence_quote_required"
    CHECK ("doctrinal_treatment" = 'not_stated' OR ("evidence_quote" IS NOT NULL AND btrim("evidence_quote") <> ''))
);--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_citation_doctrine_reviews_citation_idx"
  ON "case_law_citation_doctrine_reviews" ("citing_decision_id", "citation_key");--> statement-breakpoint

-- Read by ingestion when it writes a decision's citations; written only by
-- the operator script on the owner connection. The request role gets nothing.
ALTER TABLE "case_law_citation_doctrine_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_citation_doctrine_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_citation_doctrine_reviews"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY "citation_doctrine_reviews_owner_access" ON "case_law_citation_doctrine_reviews"
  FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_citation_doctrine_reviews'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_citation_doctrine_reviews'::regclass));--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_citation_doctrine_reviews"
  FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
-- Public-reader column grants follow after this release accepts them as permitted.
GRANT SELECT ON TABLE "case_law_citation_doctrine_reviews" TO stella_ingestion;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_citation_doctrine_reviews" FROM stella;
