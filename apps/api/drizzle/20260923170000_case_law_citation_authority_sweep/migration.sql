SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Where the citation-authority sweep is in its current pass. The sweep walks
-- decisions in id order and writes only the ones whose value moved, so its
-- schedule is kept here rather than stamped on every row it visits.
CREATE TABLE IF NOT EXISTS "case_law_citation_authority_sweep" (
  "scope" text PRIMARY KEY NOT NULL,
  "cursor_decision_id" uuid,
  "pass_started_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Added validating: the table is created empty in this same migration.
ALTER TABLE "case_law_citation_authority_sweep"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_authority_sweep_scope_values"
  CHECK ("scope" IN ('global'));--> statement-breakpoint

ALTER TABLE "case_law_citation_authority_sweep"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_citation_authority_sweep" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_authority_sweep" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_citation_authority_sweep" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_citation_authority_sweep" TO stella_ingestion;
