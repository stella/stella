SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A reviewed polarity per (citing decision, citation key). Citation rows are
-- re-inserted under new ids on every refresh of the citing decision, so the
-- review is keyed on what survives the refresh.
CREATE TABLE "case_law_citation_reviews" (
  "id" uuid PRIMARY KEY NOT NULL,
  "citing_decision_id" uuid NOT NULL,
  "citation_key" varchar(128) NOT NULL,
  "polarity" varchar(16) NOT NULL,
  "review_ref" varchar(200) NOT NULL,
  "reviewed_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_citation_reviews_citing_decision_fk"
    FOREIGN KEY ("citing_decision_id")
    REFERENCES "case_law_decisions"("id")
    ON DELETE CASCADE,
  -- Derived from REVIEWABLE_POLARITIES.
  CONSTRAINT "citation_reviews_polarity_values"
    CHECK ("polarity" IN ('positive', 'supportive', 'neutral', 'negative', 'mixed')),
  CONSTRAINT "citation_reviews_citation_key_non_empty"
    CHECK ("citation_key" <> ''),
  CONSTRAINT "citation_reviews_review_ref_non_empty"
    CHECK ("review_ref" <> '')
);--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_citation_reviews_citation_idx"
  ON "case_law_citation_reviews" ("citing_decision_id", "citation_key");--> statement-breakpoint

-- Read by ingestion when it writes a decision's citations; written only by
-- the operator script on the owner connection. The request role gets nothing.
ALTER TABLE "case_law_citation_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_citation_reviews"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_citation_reviews" TO stella_ingestion;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_citation_reviews" FROM stella;
