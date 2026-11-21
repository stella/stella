-- requires: 20261007090100_validate_case_law_citation_review_provenance
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_analysis_failures" (
  "decision_id" uuid NOT NULL,
  "key_tag" text NOT NULL,
  "input_fingerprint" text NOT NULL,
  "code" text NOT NULL,
  "key_source" text NOT NULL,
  "provider" text,
  "recorded_at" timestamptz NOT NULL,
  CONSTRAINT "case_law_analysis_failures_pkey" PRIMARY KEY("decision_id", "key_tag"),
  CONSTRAINT "case_law_analysis_failures_code_values"
    CHECK ("code" IN ('answer_incomplete', 'timed_out', 'provider_refused', 'provider_unavailable', 'failed')),
  CONSTRAINT "case_law_analysis_failures_key_shape"
    CHECK (("key_source" = 'organization' AND "provider" IS NOT NULL)
      OR ("key_source" = 'platform' AND "provider" IS NULL))
);--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts -- the new table is empty, so validating its foreign key takes no live-table scan
ALTER TABLE "case_law_analysis_failures"
  ADD CONSTRAINT "case_law_analysis_failure_decision_fk"
  FOREIGN KEY ("decision_id") REFERENCES "public"."case_law_decisions"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "case_law_analysis_failures_recorded_at_idx"
  ON "case_law_analysis_failures" ("recorded_at");--> statement-breakpoint

ALTER TABLE "case_law_analysis_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_analysis_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The owner connection runs the analysis and is the only reader and writer;
-- application roles cannot reach these rows even if privileges are later
-- granted.
CREATE POLICY "case_law_analysis_failure_owner_access" ON "case_law_analysis_failures"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_analysis_failures'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_analysis_failures'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_analysis_failures" FROM stella;
