-- requires: 20261020093000_cz_uohs_metadata_url_contract
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "parsed_source_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "parsed_source_hash_version" smallint,
  ADD COLUMN IF NOT EXISTS "parsed_source_raw_s3_key" varchar(512);--> statement-breakpoint

-- Keep the deployed pair primary key and permit old writers to omit the new
-- input key. NULL records unknown provenance rather than a guessed generation.
ALTER TABLE "case_law_replay_blocked"
  ADD COLUMN IF NOT EXISTS "source_raw_s3_key" varchar(512);--> statement-breakpoint
ALTER TABLE "case_law_replay_batches"
  ADD COLUMN IF NOT EXISTS "source_raw_s3_key" varchar(512);--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_parsed_source_complete"
  CHECK (
    (parsed_source_hash IS NULL AND parsed_source_hash_version IS NULL AND parsed_source_raw_s3_key IS NULL)
    OR (parsed_source_hash IS NOT NULL AND parsed_source_hash_version IS NOT NULL AND parsed_source_hash_version >= 0 AND parsed_source_raw_s3_key IS NOT NULL)
  ) NOT VALID;--> statement-breakpoint

-- Old binaries may replace derived output without advancing an observation
-- order, or retain the old raw pointer after an upload failure. Every actual
-- parse/input change invalidates provenance. The canonical new writer stamps
-- its proved input in a second metadata-only statement under the same row lock.
CREATE FUNCTION invalidate_case_law_parsed_source()
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
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_decisions_parsed_source_invalidation
BEFORE UPDATE ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION invalidate_case_law_parsed_source();--> statement-breakpoint
