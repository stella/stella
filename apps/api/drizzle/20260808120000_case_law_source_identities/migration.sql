SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Exact publisher identities are reserved before the decision row write.
-- This indirection lets canonical and fallback observations that overlap in
-- time converge on one UUID even though they use different uniqueness keys.
-- decision_id deliberately has no foreign key: the reservation must commit
-- before the slower decision/raw/corpus work, and a retry completes an
-- abandoned reservation with the same UUID.
CREATE TABLE IF NOT EXISTS "case_law_decision_source_identities" (
  "source_id" uuid NOT NULL,
  "source_document_id" varchar(256) NOT NULL,
  "decision_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_source_identities_pk"
    PRIMARY KEY ("source_id", "source_document_id")
);--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_decision_source_identities"
  ADD CONSTRAINT "case_law_decision_source_identities_source_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_decision_source_identities_decision_idx"
  ON "case_law_decision_source_identities" ("decision_id");--> statement-breakpoint

ALTER TABLE "case_law_decision_source_identities"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_decision_source_identities"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES
  ON TABLE "case_law_decision_source_identities" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_source_identities" TO stella_ingestion;
