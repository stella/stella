-- requires: 20260516000000_case_law_ingestion_role
-- requires: 20260823190000_public_law_reader_role
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Empty side table only: no parent scan, backfill, or parent index/check.
CREATE TABLE "case_law_text_retention_verdicts" (
  "decision_id" uuid PRIMARY KEY REFERENCES "case_law_decisions" ("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "case_law_sources" ("id") ON DELETE CASCADE,
  "raw_s3_key" text,
  "raw_fingerprint" varchar(64),
  "payload_fingerprint" varchar(64) NOT NULL,
  "composition_fingerprint" varchar(64) NOT NULL,
  "source_hash" varchar(64),
  "parser_version" integer NOT NULL,
  "oracle_version" integer NOT NULL,
  "exclusion_version" integer NOT NULL,
  "checked_at" timestamptz DEFAULT now() NOT NULL,
  "status" text NOT NULL,
  "retained_ratio" double precision,
  "defect" text,
  "reason" text,
  "missing_sample_hash" varchar(64),
  "components" jsonb NOT NULL,
  CONSTRAINT "case_law_text_retention_status_shape" CHECK (CASE status WHEN 'assessed' THEN retained_ratio IS NOT NULL AND retained_ratio >= 0 AND retained_ratio <= 1 AND reason IS NULL AND (defect IS NULL OR defect = 'text_loss_suspected') WHEN 'empty_source' THEN retained_ratio IS NULL AND defect IS NULL AND reason IS NULL AND missing_sample_hash IS NULL WHEN 'unavailable' THEN retained_ratio IS NULL AND defect IS NULL AND reason IS NOT NULL AND missing_sample_hash IS NULL ELSE false END),
  CONSTRAINT "case_law_text_retention_versions" CHECK (parser_version >= 0 AND oracle_version > 0 AND exclusion_version > 0),
  CONSTRAINT "case_law_text_retention_fingerprints" CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$' AND composition_fingerprint ~ '^[0-9a-f]{64}$' AND (raw_fingerprint IS NULL OR raw_fingerprint ~ '^[0-9a-f]{64}$') AND (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$') AND (missing_sample_hash IS NULL OR missing_sample_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "case_law_text_retention_components" CHECK (jsonb_typeof(components) = 'array'),
  CONSTRAINT "case_law_text_retention_reason_values" CHECK (reason IS NULL OR reason IN ('unavailable', 'malformed', 'unsupported', 'resource_limit', 'no_text_layer', 'no_raw', 'composite_unreverifiable', 'ambiguous_component', 'missing_output', 'unknown_source', 'raw_mismatch', 'payload_mismatch', 'raw_read_failed', 'payload_read_failed', 'missing_snapshot', 'source_mismatch'))
);--> statement-breakpoint
CREATE INDEX "case_law_text_retention_source_decision_idx"
  ON "case_law_text_retention_verdicts" ("source_id", "decision_id");--> statement-breakpoint
ALTER TABLE "case_law_text_retention_verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_text_retention_verdicts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_text_retention_verdicts"
  AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_text_retention_verdicts"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_text_retention_verdicts"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - FORCE RLS needs owner access; no PUBLIC privileges are granted, service roles receive only the explicit table or column privileges below
CREATE POLICY "case_law_text_retention_owner_access" ON "case_law_text_retention_verdicts"
  AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_text_retention_verdicts" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT (decision_id, payload_fingerprint, parser_version, oracle_version, exclusion_version, checked_at, status, retained_ratio, defect, reason)
  ON TABLE "case_law_text_retention_verdicts" TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (decision_id, payload_fingerprint, parser_version, oracle_version, exclusion_version, checked_at, status, retained_ratio, defect, reason)
  ON TABLE "case_law_text_retention_verdicts" TO stella;--> statement-breakpoint
GRANT SELECT (parser_version) ON TABLE "case_law_decisions" TO stella_public_law_reader;
