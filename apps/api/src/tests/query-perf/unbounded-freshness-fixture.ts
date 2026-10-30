import { sql } from "drizzle-orm";

/**
 * The case-law freshness report's reads before they were bounded: a count of
 * every queued state and of every unsettled revision of the family, across
 * all generations. Kept as a fixture so the gate proves, on every run, that
 * it refuses the shape that read the projection tables whole.
 */
export const UNBOUNDED_FRESHNESS_STATEMENTS = [
  sql`WITH pending AS (
    SELECT coalesce(desired_at, created_at) AS pending_since,
      CASE WHEN desired_at IS NULL
        THEN 'state_created_at_fallback'
        ELSE 'desired_at'
      END AS age_source
    FROM corpus_index_projection_states
    WHERE family = 'case_law' AND desired_epoch > coalesce(applied_epoch, -1)
  )
  SELECT count(*)::int AS count,
    coalesce(extract(epoch FROM clock_timestamp() - min(pending_since)), 0)::float8 AS age,
    coalesce((array_agg(age_source ORDER BY pending_since))[1], 'none') AS age_source
  FROM pending`,
  sql`SELECT count(*)::int AS count,
    coalesce(extract(epoch FROM clock_timestamp() - min(created_at)), 0)::float8 AS age
    FROM corpus_index_projection_intents
    WHERE family = 'case_law'
      AND status <> 'settled'
      AND status <> 'cancelled'`,
] as const;
