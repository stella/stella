SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
-- Only the repeated suffix belongs to the cycle: an acyclic tail must not
-- become a repair candidate, even when its id sorts before every cycle member.
-- The statement budget bounds this one-time repair; a timeout rolls it back.
WITH RECURSIVE parent_walk AS (
  SELECT workspace_id, id, parent_id, ARRAY[id] AS path, false AS closed
  FROM entities
  WHERE kind = 'folder'
  UNION ALL
  SELECT w.workspace_id, e.id, e.parent_id, w.path || e.id,
         e.id = ANY(w.path)
  FROM parent_walk w
  JOIN entities e ON e.workspace_id = w.workspace_id AND e.id = w.parent_id
  WHERE NOT w.closed
), cycle_roots AS (
  SELECT DISTINCT workspace_id,
         (SELECT member
          FROM unnest(path[array_position(path, id):cardinality(path) - 1]) AS member
          ORDER BY member
          LIMIT 1) AS id
  FROM parent_walk
  WHERE closed
)
UPDATE entities e
SET parent_id = NULL
FROM cycle_roots r
WHERE e.workspace_id = r.workspace_id AND e.id = r.id
  AND e.parent_id IS NOT NULL;
