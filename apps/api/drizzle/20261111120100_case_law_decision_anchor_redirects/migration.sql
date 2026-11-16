SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Where a decision's block anchors went when a write replaced its document:
-- one row per anchor the stored document no longer holds, pointing at the
-- anchor now holding its text, or NULL when nothing does. Written in the
-- decision write's transaction; chains are flattened there, so a lookup is
-- one hop. Corpus data: readable by the request and public-law reader roles,
-- written by ingestion only.
CREATE TABLE "case_law_decision_anchor_redirects" (
  "decision_id" uuid NOT NULL,
  "from_anchor" text NOT NULL,
  "to_anchor" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_anchor_redirects_pk" PRIMARY KEY ("decision_id", "from_anchor"),
  CONSTRAINT "case_law_decision_anchor_redirects_decision_id_fk"
    FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE,
  CONSTRAINT "case_law_decision_anchor_redirects_anchors_shape"
    CHECK ("from_anchor" <> '' AND ("to_anchor" IS NULL OR ("to_anchor" <> '' AND "to_anchor" <> "from_anchor")))
);--> statement-breakpoint

ALTER TABLE "case_law_decision_anchor_redirects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_decision_anchor_redirects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_decision_anchor_redirects"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_decision_anchor_redirects"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_decision_anchor_redirects"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_decision_anchor_redirects" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_decision_anchor_redirects" TO stella;--> statement-breakpoint
-- Exactly the columns the public redirect read answers from.
GRANT SELECT (decision_id, from_anchor, to_anchor)
  ON TABLE "case_law_decision_anchor_redirects" TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_anchor_redirects" TO stella_ingestion;
