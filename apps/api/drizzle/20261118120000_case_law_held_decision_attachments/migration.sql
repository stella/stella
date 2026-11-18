SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- A source's record that enriches a decision another source holds, instead
-- of becoming a second row of the same decision: its typed metadata, raw
-- payload and provenance, keyed by the record's own publisher identity and
-- naming the host decision. host_decision_id has no foreign key: a retired
-- host resolves through case_law_decision_aliases, and an erased or deleted
-- host leaves the record parked for the census to name. Written by
-- ingestion only.
CREATE TABLE "case_law_held_decision_attachments" (
  "source_id" uuid NOT NULL,
  "source_document_id" varchar(256) NOT NULL,
  "match_basis" varchar(32) NOT NULL,
  "host_decision_id" uuid,
  "host_withdrawn_at" timestamptz,
  "candidate_decision_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "metadata" jsonb,
  "declared_identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_url" varchar(2048),
  "source_hash" varchar(64) NOT NULL,
  "source_raw_s3_key" varchar(512),
  "source_raw_content_type" varchar(128),
  "observed_at" timestamptz NOT NULL,
  "observation_order" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_held_decision_attachments_pk"
    PRIMARY KEY ("source_id", "source_document_id"),
  CONSTRAINT "case_law_held_decision_attachments_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "case_law_held_decision_attachments_basis_values"
    CHECK ("match_basis" IN ('ecli', 'court-docket-date')),
  CONSTRAINT "case_law_held_decision_attachments_host_shape"
    CHECK (("host_decision_id" IS NULL) = (cardinality("candidate_decision_ids") >= 2)
      AND ("host_decision_id" IS NULL OR cardinality("candidate_decision_ids") = 0)),
  CONSTRAINT "case_law_held_decision_attachments_withdrawn_shape"
    CHECK ("host_withdrawn_at" IS NULL OR ("host_decision_id" IS NOT NULL AND "metadata" IS NULL AND "source_raw_s3_key" IS NULL))
);--> statement-breakpoint

CREATE INDEX "case_law_held_decision_attachments_host_idx"
  ON "case_law_held_decision_attachments" ("host_decision_id")
  WHERE "host_decision_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "case_law_held_decision_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_held_decision_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_held_decision_attachments"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_held_decision_attachments" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_held_decision_attachments" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_held_decision_attachments" TO stella_ingestion;
