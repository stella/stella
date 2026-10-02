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
), cycle_members AS (
  SELECT DISTINCT workspace_id,
         unnest(path[array_position(path, id):cardinality(path) - 1]) AS id
  FROM parent_walk
  WHERE closed
)
SELECT count(DISTINCT workspace_id) AS workspaces_on_cycles,
       count(*) AS entities_on_cycles
FROM cycle_members;
