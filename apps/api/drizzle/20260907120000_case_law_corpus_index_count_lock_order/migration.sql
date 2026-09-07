SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The count triggers update one bucket per (generation, index_id) a statement
-- touches. `UPDATE ... FROM deltas` leaves the row-lock order to the plan, so
-- two transactions whose statements touch the same buckets in different orders
-- can each hold a lock the other needs and deadlock. Every writer of
-- case_law_corpus_index_projections is exposed: one decision update cascades
-- into several buckets.
--
-- The buckets are now locked in primary-key order before the update, the same
-- order in every transaction, so concurrent writers queue instead. The deltas
-- are aggregated once into an array (one element per bucket, a small set
-- whatever the statement's row count) and reused by the seed insert, the lock,
-- and the update; the previous shape re-derived them per statement.
-- `text` rather than the columns' varchar widths: the cast into this type is
-- how a bucket key is carried, and a narrower width would truncate a widened
-- key into the wrong bucket instead of failing.
CREATE TYPE case_law_corpus_index_count_delta AS (
  generation text,
  index_id text,
  delta bigint
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION add_inserted_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  bucket_deltas case_law_corpus_index_count_delta[];
BEGIN
  SELECT array_agg(
    (generation, index_id, delta)::case_law_corpus_index_count_delta
    ORDER BY generation, index_id
  )
  INTO bucket_deltas
  FROM (
    SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
    FROM new_projections
    WHERE accounted_index_id IS NOT NULL
    GROUP BY generation, accounted_index_id
  ) AS changes;

  IF bucket_deltas IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO case_law_corpus_index_counts (
    generation,
    index_id,
    marked_indexed,
    updated_at
  )
  SELECT deltas.generation, deltas.index_id, 0, clock_timestamp()
  FROM unnest(bucket_deltas) AS deltas
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_counts_pk DO NOTHING;

  -- After the seed insert, which keeps no row lock of its own, and before the
  -- update, which would otherwise lock the buckets in plan order.
  PERFORM 1
  FROM case_law_corpus_index_counts AS counts
  WHERE (counts.generation, counts.index_id) IN (
    SELECT deltas.generation, deltas.index_id
    FROM unnest(bucket_deltas) AS deltas
  )
  ORDER BY counts.generation, counts.index_id
  FOR UPDATE;

  UPDATE case_law_corpus_index_counts AS counts
  SET marked_indexed = counts.marked_indexed + deltas.delta,
      updated_at = clock_timestamp()
  FROM unnest(bucket_deltas) AS deltas
  WHERE counts.generation = deltas.generation
    AND counts.index_id = deltas.index_id;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION apply_updated_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  bucket_deltas case_law_corpus_index_count_delta[];
BEGIN
  SELECT array_agg(
    (generation, index_id, delta)::case_law_corpus_index_count_delta
    ORDER BY generation, index_id
  )
  INTO bucket_deltas
  FROM (
    SELECT generation, index_id, sum(delta)::bigint AS delta
    FROM (
      SELECT generation, accounted_index_id AS index_id, -count(*)::bigint AS delta
      FROM old_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
      UNION ALL
      SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
      FROM new_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
    ) AS changes
    GROUP BY generation, index_id
    HAVING sum(delta) <> 0
  ) AS bucket_changes;

  IF bucket_deltas IS NULL THEN
    RETURN NULL;
  END IF;

  -- Materialize a zero bucket first. A negative delta without an existing
  -- bucket then violates the nonnegative CHECK instead of disappearing.
  INSERT INTO case_law_corpus_index_counts (
    generation,
    index_id,
    marked_indexed,
    updated_at
  )
  SELECT deltas.generation, deltas.index_id, 0, clock_timestamp()
  FROM unnest(bucket_deltas) AS deltas
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_counts_pk DO NOTHING;

  PERFORM 1
  FROM case_law_corpus_index_counts AS counts
  WHERE (counts.generation, counts.index_id) IN (
    SELECT deltas.generation, deltas.index_id
    FROM unnest(bucket_deltas) AS deltas
  )
  ORDER BY counts.generation, counts.index_id
  FOR UPDATE;

  UPDATE case_law_corpus_index_counts AS counts
  SET marked_indexed = counts.marked_indexed + deltas.delta,
      updated_at = clock_timestamp()
  FROM unnest(bucket_deltas) AS deltas
  WHERE counts.generation = deltas.generation
    AND counts.index_id = deltas.index_id;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION subtract_deleted_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  bucket_deltas case_law_corpus_index_count_delta[];
BEGIN
  SELECT array_agg(
    (generation, index_id, delta)::case_law_corpus_index_count_delta
    ORDER BY generation, index_id
  )
  INTO bucket_deltas
  FROM (
    SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
    FROM old_projections
    WHERE accounted_index_id IS NOT NULL
    GROUP BY generation, accounted_index_id
  ) AS changes;

  IF bucket_deltas IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1
  FROM case_law_corpus_index_counts AS counts
  WHERE (counts.generation, counts.index_id) IN (
    SELECT deltas.generation, deltas.index_id
    FROM unnest(bucket_deltas) AS deltas
  )
  ORDER BY counts.generation, counts.index_id
  FOR UPDATE;

  UPDATE case_law_corpus_index_counts AS counts
  SET marked_indexed = counts.marked_indexed - deltas.delta,
      updated_at = clock_timestamp()
  FROM unnest(bucket_deltas) AS deltas
  WHERE counts.generation = deltas.generation
    AND counts.index_id = deltas.index_id;

  IF EXISTS (
    SELECT 1
    FROM old_projections AS deleted
    WHERE deleted.accounted_index_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM case_law_corpus_index_backfills AS generation
        WHERE generation.generation = deleted.generation
      )
      AND NOT EXISTS (
        SELECT 1
        FROM case_law_corpus_index_counts AS counts
        WHERE counts.generation = deleted.generation
          AND counts.index_id = deleted.accounted_index_id
      )
  ) THEN
    RAISE EXCEPTION 'case-law corpus index accounting bucket is missing';
  END IF;
  RETURN NULL;
END
$function$;--> statement-breakpoint
