SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN "fallback_identity_key" varchar(320),
  ADD COLUMN "fallback_cohort_key" varchar(320),
  ADD COLUMN "fallback_content_hash" varchar(64),
  ADD COLUMN "fallback_publication_hash" varchar(64),
  ADD COLUMN "fallback_document_hash" varchar(64);
-- The source-scoped unique index is built by the governed online runner.
-- Existing rows are not rewritten; an observed exact identity fills its key.
--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT * FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');
--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT * FROM "case_law_decisions" WHERE redacted_at IS NULL;

--> statement-breakpoint
-- Aliases are claimed with the decision row write; a retired UUID resolves through the canonical alias owner.
CREATE TABLE "case_law_decision_fallback_identities" (
  "source_id" uuid NOT NULL REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "identity_key" varchar(320) NOT NULL,
  "decision_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_fallback_identities_pk" PRIMARY KEY ("source_id","identity_key"),
  CONSTRAINT "case_law_decision_fallback_identities_strong_key" CHECK (left(identity_key,length('case-number:v2:["decision",')) = 'case-number:v2:["decision",')
);
--> statement-breakpoint
CREATE INDEX "case_law_decision_fallback_identities_decision_idx" ON "case_law_decision_fallback_identities" ("decision_id");
--> statement-breakpoint
ALTER TABLE "case_law_decision_fallback_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_decision_fallback_identities"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_decision_fallback_identities" FROM stella;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_decision_fallback_identities" TO stella_ingestion;
