SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  ADD COLUMN "printed_work_identifier" text;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the replacement admits the old values and one new value, in the same transaction
ALTER TABLE "case_law_provision_citations"
  DROP CONSTRAINT "provision_citations_selection_values";--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_selection_values"
  CHECK ("selection" IS NULL OR "selection" IN ('text','date-window','misprint-correction')) NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "provision_citations_misprint_correction_shape"
  CHECK (CASE WHEN "selection" = 'misprint-correction'
    THEN "printed_work_identifier" IS NOT NULL
      AND "printed_work_identifier" <> "work_identifier"
    ELSE "printed_work_identifier" IS NULL END) NOT VALID;--> statement-breakpoint

-- Hash the columns the public reader is allowed to select. Keep the same
-- JSONB encoding as the row overload used by the ingestion trigger.
CREATE FUNCTION "case_law_provision_extraction_input_digest"(
  content_hash text,
  decision_date date,
  country text,
  language text,
  unredacted boolean
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    'case-law-provision-extraction-input/1',
    content_hash,
    CASE
      WHEN decision_date IS NULL THEN NULL
      WHEN isfinite(decision_date)
        THEN to_jsonb(decision_date - DATE '2000-01-01')
      WHEN decision_date > DATE '2000-01-01' THEN to_jsonb('+infinity'::text)
      ELSE to_jsonb('-infinity'::text)
    END,
    country,
    language,
    unredacted
  )::text, 'UTF8'));
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "case_law_provision_extraction_input_digest"(decision "case_law_decisions")
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT case_law_provision_extraction_input_digest(
    decision."content_hash",
    decision."decision_date",
    decision."country",
    decision."language",
    decision."redacted_at" IS NULL
  );
$$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "case_law_provision_extraction_in_scope"(varchar, varchar)
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "case_law_provision_extraction_input_digest"(text, date, text, text, boolean)
  TO "stella_public_law_reader";--> statement-breakpoint

GRANT SELECT (
  decision_id, desired_input_digest, work_status, generation, outcome,
  published_input_digest, published_jurisdiction, published_revision,
  published_projection_digest, payload_class, payload_class_input_digest
) ON TABLE "case_law_provision_extractions" TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (jurisdiction, revision)
  ON TABLE "case_law_provision_extraction_revisions_registry"
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (jurisdiction, min_current_revision)
  ON TABLE "case_law_provision_extraction_revisions"
  TO "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT (
  span_role, print_piece_id, print_start, print_end, print_text,
  name_piece_id, name_start, name_end, name_text, selection,
  printed_work_identifier,
  target_document_id, target_status
) ON TABLE "case_law_provision_citations" TO "stella_public_law_reader";
