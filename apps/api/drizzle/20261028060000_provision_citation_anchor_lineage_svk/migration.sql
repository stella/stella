-- requires: 20261025120000_provision_citation_anchor_lineage_usa
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Slovak anchors nest on `.` (`paragraf-451.odsek-1`). Mirrors
-- `provisionAnchorLineage` in apps/api/src/lib/case-law/provision-anchor-lineage.ts;
-- SVK had no supported grammar before, so it minted no anchors and no stored
-- membership is rebuilt.
CREATE OR REPLACE FUNCTION "case_law_provision_anchor_lineage"(target_jurisdiction text, target_anchor text)
RETURNS text[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
SELECT CASE
  WHEN target_anchor = '' THEN ARRAY[]::text[]
  WHEN split.separator IS NULL THEN ARRAY[target_anchor]
  ELSE ARRAY(
    SELECT array_to_string(split.parts[1:depth], split.separator)
    FROM generate_series(1, cardinality(split.parts)) AS depth
    ORDER BY depth
  )
END
FROM (
  SELECT known.separator, string_to_array(target_anchor, known.separator) AS parts
  FROM (
    SELECT CASE target_jurisdiction WHEN 'CZE' THEN '-' WHEN 'EU' THEN '-' WHEN 'SVK' THEN '.' WHEN 'USA' THEN '/' END AS separator
  ) known
) split
$$;
