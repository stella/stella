-- requires: 20261022120000_case_law_batch_slots
-- requires: 20261026120100_case_law_extraction_warnings
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Extraction diagnostics belong to the stored parse, so changing them also
-- invalidates its proof. Replacing the function preserves the attached trigger.
CREATE OR REPLACE FUNCTION invalidate_case_law_parsed_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(
    OLD."source_id",
    OLD."case_number",
    OLD."slug",
    OLD."case_number_type",
    OLD."source_document_id",
    OLD."ecli",
    OLD."court",
    OLD."court_id",
    OLD."country",
    OLD."language",
    OLD."sheet_number",
    OLD."language_group_key",
    OLD."decision_date",
    OLD."decision_type",
    OLD."extraction_warnings",
    OLD."source_url",
    OLD."document_url",
    OLD."metadata",
    OLD."citation_key",
    OLD."docket_family_key",
    OLD."parser_version",
    OLD."fulltext",
    OLD."sections",
    OLD."document_ast",
    OLD."content_hash",
    OLD."text_s3_key",
    OLD."normalized_s3_key",
    OLD."ast_s3_key",
    OLD."source_raw",
    OLD."source_raw_s3_key",
    OLD."source_raw_content_type",
    OLD."source_hash",
    OLD."source_hash_version",
    OLD."redacted_at"
  ) IS DISTINCT FROM ROW(
    NEW."source_id",
    NEW."case_number",
    NEW."slug",
    NEW."case_number_type",
    NEW."source_document_id",
    NEW."ecli",
    NEW."court",
    NEW."court_id",
    NEW."country",
    NEW."language",
    NEW."sheet_number",
    NEW."language_group_key",
    NEW."decision_date",
    NEW."decision_type",
    NEW."extraction_warnings",
    NEW."source_url",
    NEW."document_url",
    NEW."metadata",
    NEW."citation_key",
    NEW."docket_family_key",
    NEW."parser_version",
    NEW."fulltext",
    NEW."sections",
    NEW."document_ast",
    NEW."content_hash",
    NEW."text_s3_key",
    NEW."normalized_s3_key",
    NEW."ast_s3_key",
    NEW."source_raw",
    NEW."source_raw_s3_key",
    NEW."source_raw_content_type",
    NEW."source_hash",
    NEW."source_hash_version",
    NEW."redacted_at"
  ) THEN
    NEW.parsed_source_hash := NULL;
    NEW.parsed_source_hash_version := NULL;
    NEW.parsed_source_raw_s3_key := NULL;
  END IF;
  RETURN NEW;
END
$function$;
