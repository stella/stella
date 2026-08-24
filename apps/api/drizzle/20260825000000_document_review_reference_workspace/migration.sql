SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Pinned reference documents now record the matter they were pinned from.
-- Every reference pinned before this could only come from the run's own
-- matter, so that matter (and its current name) is what they are stamped with.
UPDATE "document_review_runs" AS r
SET "basis" = jsonb_set(
  r."basis",
  '{references}',
  (
    SELECT jsonb_agg(
      ref || jsonb_build_object(
        'workspaceId', r."workspace_id",
        'workspaceName', w."name"
      )
    )
    FROM jsonb_array_elements(r."basis" -> 'references') AS ref
  ),
  true
)
FROM "workspaces" AS w
WHERE w."id" = r."workspace_id"
  AND jsonb_typeof(r."basis" -> 'references') = 'array'
  AND jsonb_array_length(r."basis" -> 'references') > 0
  AND NOT (r."basis" -> 'references' -> 0 ? 'workspaceId');
