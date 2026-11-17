SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- When the decision's content last changed, so a consumer can read only the
-- rows whose content changed since it last looked. Nullable with no default,
-- so adding it rewrites no stored row: NULL means unchanged since this
-- migration. The trigger below owns every later value.
ALTER TABLE "case_law_decisions" ADD COLUMN "content_changed_at" timestamptz;--> statement-breakpoint

-- The decision views expand SELECT * when defined, so they are redefined to
-- carry the new column with their filters unchanged.
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT * FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT * FROM "case_law_decisions" WHERE redacted_at IS NULL;--> statement-breakpoint

-- The content columns are CASE_LAW_CONTENT_COLUMNS in
-- src/db/case-law-content-changed-at.ts; its test holds this list to it.
-- Full text counts by its stored size, which is read from the value's header,
-- so an update never detoasts the old text to compare it.
--
-- Every stamp is the time of the write itself: an update stamps the clock
-- when a content column's value actually changed and otherwise keeps the
-- stored value, which a writer therefore cannot set. An insert stamps its
-- created_at, which defaults to the clock a moment earlier; a created_at the
-- writer chose (older or newer) stamps the clock instead. So a write
-- stamped before an instant belongs to a transaction that held its id within
-- a second of that instant: a reader that waits for every transaction that
-- old to end, then reads up to the instant, misses no row.
CREATE FUNCTION stamp_case_law_content_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.content_changed_at := CASE
      WHEN NEW.created_at BETWEEN clock_timestamp() - interval '1 second'
        AND clock_timestamp()
      THEN NEW.created_at
      ELSE clock_timestamp()
    END;
  ELSIF ROW(
      NEW.source_id,
      NEW.redacted_at,
      NEW.country,
      NEW.case_number,
      NEW.court,
      NEW.decision_type,
      NEW.ecli,
      octet_length(NEW.fulltext),
      NEW.metadata
    ) IS DISTINCT FROM ROW(
      OLD.source_id,
      OLD.redacted_at,
      OLD.country,
      OLD.case_number,
      OLD.court,
      OLD.decision_type,
      OLD.ecli,
      octet_length(OLD.fulltext),
      OLD.metadata
    )
  THEN
    NEW.content_changed_at := clock_timestamp();
  ELSE
    NEW.content_changed_at := OLD.content_changed_at;
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

-- Row triggers of one timing fire in name order. This name sorts after every
-- before-row trigger that can change a content column (the redaction fence
-- sets redacted_at on a write that names only payload columns), so it compares
-- the row they leave. It fires on every update rather than on a column list
-- for the same reason: a column list sees only the columns a statement names.
-- Only the parsed-input state trigger sorts after it, and that writes no
-- content column.
CREATE TRIGGER case_law_decisions_zy_content_changed_at
BEFORE INSERT OR UPDATE ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION stamp_case_law_content_change();--> statement-breakpoint

-- The (source_id, content_changed_at, id) index is built concurrently after
-- deploy by its online migration entry in
-- src/db/online-migration-entries/.
