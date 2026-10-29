SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_decisions" ADD COLUMN "review_extraction_version" smallint;--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT * FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT * FROM "case_law_decisions" WHERE redacted_at IS NULL;--> statement-breakpoint

CREATE TABLE "case_law_decision_reviews" (
  "reviewing_decision_id" uuid NOT NULL CONSTRAINT "case_law_decision_reviews_reviewing_fk" REFERENCES "case_law_decisions"("id") ON DELETE CASCADE,
  "reviewed_decision_id" uuid CONSTRAINT "case_law_decision_reviews_reviewed_fk" REFERENCES "case_law_decisions"("id") ON DELETE SET NULL,
  "reviewed_case_number" varchar(256) NOT NULL,
  "reviewed_citation_key" varchar(128) NOT NULL,
  "reviewed_docket_family_key" text NOT NULL,
  "reviewed_court" varchar(512) NOT NULL,
  "reviewed_decision_date" date,
  "reviewed_sheet_number" varchar(32),
  "outcome" text NOT NULL,
  "source" text NOT NULL,
  "evidence_classification" text NOT NULL,
  "opening_evidence" jsonb NOT NULL,
  "parser_version" smallint NOT NULL,
  CONSTRAINT "case_law_decision_reviews_source_values" CHECK ("source" IN ('metadata', 'opening', 'history')),
  CONSTRAINT "case_law_decision_reviews_evidence_classification_values" CHECK ("evidence_classification" IN ('consistent', 'metadata_only', 'opening_only', 'conflict')),
  CONSTRAINT "case_law_decision_reviews_distinct" CHECK ("reviewing_decision_id" IS DISTINCT FROM "reviewed_decision_id"),
  CONSTRAINT "case_law_decision_reviews_outcome_values" CHECK ("outcome" IN ('upheld', 'overturned', 'partly', 'pending', 'unknown'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_decision_reviews_identity_idx" ON "case_law_decision_reviews"
("reviewing_decision_id", "reviewed_court", "reviewed_case_number", COALESCE("reviewed_decision_date", '-infinity'::date));--> statement-breakpoint
CREATE INDEX "case_law_decision_reviews_reviewed_idx" ON "case_law_decision_reviews" ("reviewed_decision_id", "reviewing_decision_id", "reviewed_court", "reviewed_case_number", "reviewed_decision_date");--> statement-breakpoint
CREATE INDEX "case_law_decision_reviews_target_idx" ON "case_law_decision_reviews" ("reviewed_court", "reviewed_docket_family_key");--> statement-breakpoint
ALTER TABLE "case_law_decision_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_decision_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_decision_reviews" FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_decision_reviews" FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_reader_access" ON "case_law_decision_reviews" FOR SELECT TO stella_caselaw_reader USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_decision_reviews" FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_decision_reviews" TO stella, stella_caselaw_reader;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_decision_reviews" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT (reviewing_decision_id, reviewed_decision_id, reviewed_case_number,
  reviewed_citation_key, reviewed_docket_family_key, reviewed_court,
  reviewed_decision_date, reviewed_sheet_number, outcome, source, evidence_classification, parser_version)
ON TABLE "case_law_decision_reviews" TO stella_public_law_reader;
