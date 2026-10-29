SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A versioned reader beside the original: releases still rolling out read
-- stella_case_law_coverage_summary() unchanged, this one serves the envelope.
-- The stored answer is served with whether it was computed under the current
-- redistribution policy, so the reader can state that a refresh is pending.
-- A source withheld since the snapshot refuses the answer only when the
-- snapshot counted it: the source existed when the answer was computed, or
-- the answer lists its feed. Its share of the country and total figures comes
-- from the search index and cannot be subtracted from the stored answer
-- exactly, so such an answer is refused rather than approximated.
-- stella-migration-safety: reviewed security-definer - fixed search path and qualified relations, PUBLIC execute revoked; returns only the singleton summary, refused while it counts a source that is no longer redistributable
CREATE FUNCTION public.stella_case_law_coverage_summary_v2() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $function$
    WITH withheld AS (
      SELECT source.id::text AS id, source.adapter_key, source.created_at
      FROM public.case_law_sources AS source
      WHERE NOT (
        source.descriptor IS NULL
        OR (source.descriptor ->> 'allowsRedistribution') = 'true'
      )
    ), current_policy AS (
      SELECT coalesce(jsonb_agg(withheld.id), '[]'::jsonb) AS ids
      FROM withheld
    )
    SELECT jsonb_build_object(
      'answer', summary.answer,
      'policyCurrent', summary.source_policy::jsonb @> current_policy.ids
        AND current_policy.ids @> summary.source_policy::jsonb
    )
    FROM public.case_law_coverage_summaries AS summary
    CROSS JOIN current_policy
    WHERE summary.key = 'current'
      AND NOT EXISTS (
        SELECT 1
        FROM withheld
        WHERE NOT summary.source_policy::jsonb @> jsonb_build_array(withheld.id)
          AND (
            withheld.created_at <= summary.generated_at
            OR jsonb_path_exists(
              summary.answer,
              '$.countries[*].sources[*] ? (@.adapterKey == $adapterKey)',
              jsonb_build_object('adapterKey', withheld.adapter_key)
            )
          )
      )
  $function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_case_law_coverage_summary_v2() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_case_law_coverage_summary_v2() TO stella_public_law_reader;
