SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE "case_law_ingestion_failure_evidence" (
  "source_id" uuid NOT NULL,
  "record_identity" varchar(256) NOT NULL,
  "identity_kind" varchar(32) NOT NULL,
  "source_document_id" varchar(256),
  "payload_hash" varchar(64) NOT NULL,
  "observation_order" bigint NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "payload" text NOT NULL,
  "error_type" varchar(128) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_ingestion_failure_evidence_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "case_law_ingestion_failure_evidence_pk"
    PRIMARY KEY ("source_id", "record_identity", "payload_hash", "error_type"),
  CONSTRAINT "case_law_ingestion_failure_evidence_identity_kind"
    CHECK ("identity_kind" IN ('source-document', 'provided-record', 'captured-input'))
);--> statement-breakpoint
CREATE INDEX "case_law_ingestion_failure_evidence_document_idx"
  ON "case_law_ingestion_failure_evidence" ("source_id", "source_document_id");--> statement-breakpoint
ALTER TABLE "case_law_ingestion_failure_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_ingestion_failure_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_ingestion_failure_evidence"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_ingestion_failure_evidence" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_ingestion_failure_evidence" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_ingestion_failure_evidence" TO stella_ingestion;
