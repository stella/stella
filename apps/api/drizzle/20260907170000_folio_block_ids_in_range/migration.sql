SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- @stll/folio-core 0.33.1 brings every paragraph id above the 31-bit bound the
-- schema sets (`w14:paraId` is `ST_LongHexNumber` < 0x80000000) into range when
-- a document is parsed, with a mapping that is a pure function of the id
-- (`currentFolioBlockId`). A block id stella recorded from such a paragraph
-- before this deploy therefore names nothing in the document as it is parsed
-- now. The stored ids move with the code, through the same mapping, so no
-- read path has to carry a legacy resolution step.
--
-- Rows touched: every persisted DOCX block id whose first hex digit is 8-F.
--   docx_suggestions.op_payload                  every `*blockId` field of the operation
--   document_review_reference_passages.block_id  the passage's block
--   justifications.content                       `blocks[].citations[].blockId`
--   chat_messages.content                        `#folio:<id>` citation links in text parts
-- Sequential (`seq-NNNN`), blank (`blank-NNNN`) and office (`pptx-…`/`xlsx-…`)
-- ids carry no paragraph id and never match the predicate.
--
-- Idempotent: a rewritten id starts with 0-7, so the predicates stop matching.
-- None of the tables is registered in `high-volume-tables.ts`. The helper
-- functions live in the session's temporary schema, so nothing outlives the
-- migration; every call is schema-qualified because that schema is not on the
-- function search path.

-- FNV-1a over the id's code points, reduced below 0x7FFFFFFF, zero remapped to
-- 1: `deterministicHexId` in @stll/folio-core, which `currentFolioBlockId`
-- applies to an eight-hex-digit id that is out of range. Every other value is
-- returned as it is. `apps/api/src/db/folio-block-ids-in-range.db.test.ts`
-- holds this function to the package's own.
CREATE OR REPLACE FUNCTION pg_temp.folio_block_id_in_range(id text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  hash bigint := 2166136261;
  reduced bigint;
BEGIN
  IF id !~ '^[89A-Fa-f][0-9A-Fa-f]{7}$' THEN
    RETURN id;
  END IF;
  FOR character_index IN 1..length(id) LOOP
    hash := ((hash # ascii(substr(id, character_index, 1))) * 16777619) % 4294967296;
  END LOOP;
  reduced := hash % 2147483647;
  IF reduced = 0 THEN
    reduced := 1;
  END IF;
  RETURN upper(lpad(to_hex(reduced), 8, '0'));
END
$$;--> statement-breakpoint

-- `#folio:<id>` links inside prose: each distinct out-of-range id is replaced.
CREATE OR REPLACE FUNCTION pg_temp.folio_citation_block_ids_in_range(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  recorded text;
BEGIN
  FOR recorded IN
    SELECT DISTINCT (regexp_matches(value, '#folio:([89A-Fa-f][0-9A-Fa-f]{7})(?![0-9A-Fa-f])', 'g'))[1]
  LOOP
    value := regexp_replace(
      value,
      '#folio:' || recorded || '(?![0-9A-Fa-f])',
      '#folio:' || pg_temp.folio_block_id_in_range(recorded),
      'g'
    );
  END LOOP;
  RETURN value;
END
$$;--> statement-breakpoint

-- Walks a JSON value: a string under a key ending in `blockId` is an id, any
-- other string may carry citation links, objects and arrays recurse in place.
CREATE OR REPLACE FUNCTION pg_temp.folio_block_ids_in_range_jsonb(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
  key text;
  entry jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR key, entry IN SELECT * FROM jsonb_each(value) LOOP
        IF key ~ '[bB]lockId$' AND jsonb_typeof(entry) = 'string' THEN
          result := result || jsonb_build_object(key, pg_temp.folio_block_id_in_range(entry #>> '{}'));
        ELSE
          result := result || jsonb_build_object(key, pg_temp.folio_block_ids_in_range_jsonb(entry));
        END IF;
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(pg_temp.folio_block_ids_in_range_jsonb(element) ORDER BY ordinality), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(element, ordinality);
      RETURN result;
    WHEN 'string' THEN
      RETURN to_jsonb(pg_temp.folio_citation_block_ids_in_range(value #>> '{}'));
    ELSE
      RETURN value;
  END CASE;
END
$$;--> statement-breakpoint

UPDATE docx_suggestions
SET op_payload = pg_temp.folio_block_ids_in_range_jsonb(op_payload)
WHERE op_payload::text ~ '"[A-Za-z]*[bB]lockId"\s*:\s*"[89A-Fa-f][0-9A-Fa-f]{7}"';--> statement-breakpoint

UPDATE document_review_reference_passages
SET block_id = pg_temp.folio_block_id_in_range(block_id)
WHERE block_id ~ '^[89A-Fa-f][0-9A-Fa-f]{7}$';--> statement-breakpoint

UPDATE justifications
SET content = pg_temp.folio_block_ids_in_range_jsonb(content)
WHERE content::text ~ '"blockId"\s*:\s*"[89A-Fa-f][0-9A-Fa-f]{7}"';--> statement-breakpoint

UPDATE chat_messages
SET content = pg_temp.folio_block_ids_in_range_jsonb(content)
WHERE content::text ~ '#folio:[89A-Fa-f][0-9A-Fa-f]{7}';
