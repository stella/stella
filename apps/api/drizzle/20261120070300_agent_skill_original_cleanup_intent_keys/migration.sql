-- requires: 20261120070100_agent_skill_resource_originals
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
--> statement-breakpoint
-- Skill file writers may reserve cleanup ownership of a fresh original key.
-- stella-migration-safety: reviewed alter-policy - adds one branch for keys under the organization's agent-skills/originals prefix that no stored file names yet; every existing organization, writer, thread, matter and template predicate is unchanged
ALTER POLICY "buffer_object_cleanup_insert"
ON "buffer_object_cleanup_intents"
WITH CHECK (
organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND 
      "buffer_object_cleanup_intents"."writer_user_id" = (SELECT pg_catalog.current_setting('app.user_id', true))
     AND (((
      "buffer_object_cleanup_intents"."chat_thread_id" IS NOT NULL
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 1) IN (
        "buffer_object_cleanup_intents"."organization_id",
        (SELECT pg_catalog.current_setting('app.user_id', true))
      )
      AND EXISTS (
        SELECT 1 FROM chat_threads ct
        WHERE ct.id = "buffer_object_cleanup_intents"."chat_thread_id"
          AND ct.organization_id = "buffer_object_cleanup_intents"."organization_id"
          AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            ("buffer_object_cleanup_intents"."workspace_id" IS NULL AND ct.workspace_id IS NULL AND pg_catalog.cardinality(ct.data_workspace_ids) = 0)
            OR ("buffer_object_cleanup_intents"."workspace_id" IS NOT NULL AND (ct.workspace_id = "buffer_object_cleanup_intents"."workspace_id" OR ct.data_workspace_ids @> ARRAY["buffer_object_cleanup_intents"."workspace_id"]::uuid[]))
          )
      )
    ) OR (
      "buffer_object_cleanup_intents"."chat_thread_id" IS NULL
      AND "buffer_object_cleanup_intents"."workspace_id" IS NOT NULL
      AND CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 1) = "buffer_object_cleanup_intents"."organization_id"
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 2) = "buffer_object_cleanup_intents"."workspace_id"::text
    )) OR (
      "buffer_object_cleanup_intents"."chat_thread_id" IS NULL
      AND "buffer_object_cleanup_intents"."workspace_id" IS NULL
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 1) = "buffer_object_cleanup_intents"."organization_id"
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 2) = 'templates'
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 4) ~ '^write-[0-9a-f-]{36}[.]docx$'
      AND pg_catalog.array_length(pg_catalog.string_to_array("buffer_object_cleanup_intents"."object_key", '/'), 1) = 4
      AND EXISTS (
        SELECT 1 FROM templates t
        WHERE t.organization_id = "buffer_object_cleanup_intents"."organization_id"
          AND t.id::text = pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 3)
      )
    ) OR (
      "buffer_object_cleanup_intents"."chat_thread_id" IS NULL
      AND "buffer_object_cleanup_intents"."workspace_id" IS NULL
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 1) = "buffer_object_cleanup_intents"."organization_id"
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 2) = 'templates'
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]docx$'
      AND pg_catalog.array_length(pg_catalog.string_to_array("buffer_object_cleanup_intents"."object_key", '/'), 1) = 3
      AND NOT EXISTS (
        SELECT 1 FROM templates t
        WHERE t.organization_id = "buffer_object_cleanup_intents"."organization_id"
          AND (t.s3_key = "buffer_object_cleanup_intents"."object_key" OR t.id::text || '.docx' = pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 3))
      )
    ) OR (
      "buffer_object_cleanup_intents"."chat_thread_id" IS NULL
      AND "buffer_object_cleanup_intents"."workspace_id" IS NULL
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 1) = "buffer_object_cleanup_intents"."organization_id"
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 2) = 'agent-skills'
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 3) = 'originals'
      AND pg_catalog.split_part("buffer_object_cleanup_intents"."object_key", '/', 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND pg_catalog.array_length(pg_catalog.string_to_array("buffer_object_cleanup_intents"."object_key", '/'), 1) = 4
      AND NOT EXISTS (
        SELECT 1 FROM agent_skill_resources r
        WHERE r.original_s3_key = "buffer_object_cleanup_intents"."object_key"
      )
    ))
);
