-- requires: 20261030044733_case_law_extraction_warnings_generation
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Whether the parse stored for a decision was made from its current input.
-- NULL until derived: the trigger below derives it on every write, and a
-- scheduled backfill derives it for rows written before this migration. The
-- check is validated once every row is derived.
ALTER TABLE "case_law_decisions" ADD COLUMN "parsed_input_state" text;--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_parsed_input_state_check"
  CHECK ("parsed_input_state" IN ('parsed', 'unparsed')) NOT VALID;--> statement-breakpoint

-- The one owner of the comparison: the trigger, the backfill and the
-- replay's fallback for rows not yet derived all call it.
CREATE OR REPLACE FUNCTION case_law_parsed_input_state(
  source_hash text,
  source_hash_version integer,
  source_raw_s3_key text,
  parsed_source_hash text,
  parsed_source_hash_version integer,
  parsed_source_raw_s3_key text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN parsed_source_hash = source_hash
      AND parsed_source_hash_version = source_hash_version
      AND parsed_source_raw_s3_key = source_raw_s3_key
    THEN 'parsed'
    ELSE 'unparsed'
  END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION derive_case_law_parsed_input_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.parsed_input_state := case_law_parsed_input_state(
    NEW.source_hash,
    NEW.source_hash_version,
    NEW.source_raw_s3_key,
    NEW.parsed_source_hash,
    NEW.parsed_source_hash_version,
    NEW.parsed_source_raw_s3_key
  );
  RETURN NEW;
END
$function$;--> statement-breakpoint

-- Row triggers of one timing fire in name order. The name sorts after every
-- other trigger on the table, so the state is derived from the row the
-- invalidation and fence triggers leave, never from what the write proposed.
CREATE TRIGGER case_law_decisions_zz_parsed_input_state
BEFORE INSERT OR UPDATE ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION derive_case_law_parsed_input_state();--> statement-breakpoint

-- The decision views expand SELECT * when defined, so they are redefined to
-- carry the new column with their filters unchanged.
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint

CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE redacted_at IS NULL;
