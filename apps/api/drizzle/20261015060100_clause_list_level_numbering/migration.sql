-- requires: 20260429152450_entity-version-ai-summaries
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Clause paragraphs record list depth as folio's paragraph numbering
-- (`numbering: {"kind": "levelOnly", "ilvl": n}`), which is all
-- `normalizeClauseBody` and the clause body schema read. Bodies stored before
-- that change carry the depth as `listLevel` (or `list_level`); they move to
-- the new shape here, so no read path carries the old field.
--
-- Rows touched: every stored clause body with a paragraph that still has a
-- legacy depth key.
--   clauses.body          the current body
--   clause_variants.body  each variant's body
--   clause_versions.body  each saved version (restore and template links read it)
-- Template clause links reference versions and variants by id, so they hold no
-- copy of a body.
--
-- Mapping, per paragraph: the depth is `listLevel` unless that is absent or
-- JSON null, then `list_level` (the read order `normalizeClauseBody` used). An
-- integral depth becomes `numbering` with `ilvl` clamped to the OOXML range
-- 0..8 (`LIMITS.clauseNumberingLevelMin`..`Max`); below zero was rendered as
-- the top level and nine levels is the most a numbering definition has. A
-- depth that is not an integral number was ignored on read and is dropped.
-- Both legacy keys are removed either way; other fields stay as they are.
--
-- Idempotent: a rewritten paragraph has no legacy key, so the predicates stop
-- matching. None of the tables is registered in `high-volume-tables.ts`. The
-- helper functions live in the session's temporary schema, so nothing outlives
-- the migration; every call is schema-qualified because that schema is not on
-- the function search path.
-- `apps/api/src/handlers/clauses/list-level-numbering-migration.db.test.ts`
-- holds the rewrite to the normalizer, the body schema and an edit round trip.
CREATE OR REPLACE FUNCTION pg_temp.clause_paragraph_numbering(paragraph jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  depth jsonb;
  depth_value numeric;
  migrated jsonb;
BEGIN
  IF jsonb_typeof(paragraph) IS DISTINCT FROM 'object' THEN
    RETURN paragraph;
  END IF;
  depth := paragraph -> 'listLevel';
  IF depth IS NULL OR jsonb_typeof(depth) = 'null' THEN
    depth := paragraph -> 'list_level';
  END IF;
  migrated := paragraph - 'listLevel' - 'list_level';
  IF jsonb_typeof(depth) = 'number' THEN
    depth_value := (depth #>> '{}')::numeric;
    IF depth_value = trunc(depth_value) THEN
      migrated := migrated || jsonb_build_object(
        'numbering',
        jsonb_build_object(
          'kind', 'levelOnly',
          'ilvl', least(greatest(depth_value, 0), 8)::integer
        )
      );
    END IF;
  END IF;
  RETURN migrated;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.clause_body_numbering(body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'array' THEN
    RETURN body;
  END IF;
  SELECT COALESCE(jsonb_agg(pg_temp.clause_paragraph_numbering(paragraph) ORDER BY ordinality), '[]'::jsonb)
    INTO result
    FROM jsonb_array_elements(body) WITH ORDINALITY AS paragraphs(paragraph, ordinality);
  RETURN result;
END
$$;--> statement-breakpoint

UPDATE clauses
SET body = pg_temp.clause_body_numbering(body)
WHERE jsonb_typeof(body) = 'array'
  AND jsonb_path_exists(body, '$[*] ? (exists(@."listLevel") || exists(@."list_level"))');--> statement-breakpoint

UPDATE clause_variants
SET body = pg_temp.clause_body_numbering(body)
WHERE jsonb_typeof(body) = 'array'
  AND jsonb_path_exists(body, '$[*] ? (exists(@."listLevel") || exists(@."list_level"))');--> statement-breakpoint

UPDATE clause_versions
SET body = pg_temp.clause_body_numbering(body)
WHERE jsonb_typeof(body) = 'array'
  AND jsonb_path_exists(body, '$[*] ? (exists(@."listLevel") || exists(@."list_level"))');
