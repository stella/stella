SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The physical corpus-index id of a case-law decision, derived in one place.
--
-- Up to generation `case_law_v2` the id is `<generation>_<country>`, one
-- index per jurisdiction. From `case_law_v3` on it is `<generation>_<group>`,
-- where the group is the jurisdiction's entry in `CASE_LAW_INDEX_GROUPS`
-- (apps/api/src/lib/legal-search/case-law-index-groups.ts): CZE and SVK share
-- `cs_sk`, AUT and DEU share `de`, POL is `pl`, EU is `eu`, and any other
-- country is its own lowercase code. The body below is the rendering of that
-- declaration; `case-law-index-groups.db.test.ts` checks the function, the
-- query fragment, and `corpusIndexId` against each other. Ids already stored
-- for `case_law_v1` and `case_law_v2` are unchanged by this rule.
--
-- IMMUTABLE and STRICT: the result depends on its two arguments alone, and a
-- NULL argument yields NULL, the same as the concatenation it replaces.
CREATE OR REPLACE FUNCTION case_law_corpus_index_id(generation text, country text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
AS $function$
  SELECT CASE
  WHEN substring(generation from '^case_law_v([1-9][0-9]*)$')::integer
       >= 3
  THEN generation || '_' || CASE upper(country)
    WHEN 'CZE' THEN 'cs_sk'
    WHEN 'SVK' THEN 'cs_sk'
    WHEN 'POL' THEN 'pl'
    WHEN 'EU' THEN 'eu'
    WHEN 'AUT' THEN 'de'
    WHEN 'DEU' THEN 'de'
    ELSE lower(country)
  END
  ELSE generation || '_' || lower(country)
END
$function$;--> statement-breakpoint

-- The projection trigger derives a decision's target index at two points: the
-- serving-generation mark it accepts, and the pending target it enqueues. Both
-- now go through the function above; everything else in the body is as
-- 20260817150000_corpus_generation_date_walk left it. The trigger itself is
-- unchanged and keeps pointing at this function.
CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.content_hash IS NULL THEN
      INSERT INTO case_law_corpus_index_projections (
        generation,
        decision_id,
        pending_action,
        pending_hash,
        pending_index_ids,
        pending_revision,
        updated_at
      )
      SELECT checkpoint.generation, NEW.id, 'delete', null, '{}', 1, clock_timestamp()
      FROM case_law_corpus_index_backfills AS checkpoint
      WHERE EXISTS (
        SELECT 1
        FROM case_law_corpus_index_projections AS existing
        WHERE existing.generation = checkpoint.generation
          AND existing.decision_id = NEW.id
      ) OR NOT EXISTS (
        SELECT 1
        FROM case_law_corpus_index_backfills AS newer
        WHERE (newer.generation_order, newer.generation) >
          (checkpoint.generation_order, checkpoint.generation)
      )
      ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE
      SET pending_action = EXCLUDED.pending_action,
          pending_hash = EXCLUDED.pending_hash,
          pending_index_ids = ARRAY(
            SELECT DISTINCT target
            FROM unnest(
              case_law_corpus_index_projections.pending_index_ids || CASE
                WHEN case_law_corpus_index_projections.index_id IS NULL THEN '{}'
                ELSE ARRAY[case_law_corpus_index_projections.index_id]
              END
            ) AS target
          ),
          pending_revision = case_law_corpus_index_projections.pending_revision + 1,
          updated_at = EXCLUDED.updated_at;
      RETURN NEW;
    END IF;

    IF NEW.indexed_hash IS NOT NULL
      AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
      AND NEW.country IS NOT DISTINCT FROM OLD.country
      AND NEW.decision_date IS NOT DISTINCT FROM OLD.decision_date
    THEN
      -- The ordinary incremental writer owns the serving generation while a
      -- newer generation may be rebuilding. Its successful database mark is
      -- also the authoritative projection commit for that serving generation;
      -- the newer generation's independently queued action remains untouched.
      -- The decision date joins this guard because it reaches the document:
      -- an update that changes it is a content change for the index, however
      -- unchanged the text is.
      UPDATE case_law_corpus_index_projections AS projection
      SET index_id = NEW.indexed_generation,
          indexed_hash = NEW.indexed_hash,
          updated_at = clock_timestamp()
      WHERE projection.decision_id = NEW.id
        AND NEW.indexed_generation =
          case_law_corpus_index_id(projection.generation, NEW.country);
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.content_hash IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO case_law_corpus_index_projections (
    generation,
    decision_id,
    pending_action,
    pending_hash,
    pending_index_ids,
    pending_revision,
    updated_at
  )
  SELECT checkpoint.generation,
         NEW.id,
         'index',
         NEW.content_hash,
         ARRAY[case_law_corpus_index_id(checkpoint.generation, NEW.country)],
         1,
         clock_timestamp()
  FROM case_law_corpus_index_backfills AS checkpoint
  WHERE EXISTS (
    SELECT 1
    FROM case_law_corpus_index_projections AS existing
    WHERE existing.generation = checkpoint.generation
      AND existing.decision_id = NEW.id
  ) OR NOT EXISTS (
      SELECT 1
      FROM case_law_corpus_index_backfills AS newer
      WHERE (newer.generation_order, newer.generation) >
        (checkpoint.generation_order, checkpoint.generation)
    )
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE
  SET pending_action = EXCLUDED.pending_action,
      pending_hash = EXCLUDED.pending_hash,
      pending_index_ids = ARRAY(
        SELECT DISTINCT target
        FROM unnest(
          case_law_corpus_index_projections.pending_index_ids || EXCLUDED.pending_index_ids
        ) AS target
      ),
      pending_revision = case_law_corpus_index_projections.pending_revision + 1,
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END
$function$;
