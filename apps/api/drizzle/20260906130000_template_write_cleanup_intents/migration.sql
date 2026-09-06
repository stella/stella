SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - existing chat and workspace insert branches are unchanged; the added branch admits only an authenticated writer's unique DOCX attempt key beneath an existing template in the active organization.
ALTER POLICY "buffer_object_cleanup_insert"
ON "buffer_object_cleanup_intents"
WITH CHECK (
  organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
  AND writer_user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND (
    (
      (
        chat_thread_id IS NOT NULL
        AND pg_catalog.split_part(object_key, '/', 1) =
          (SELECT pg_catalog.current_setting('app.user_id', true))
        AND EXISTS (
          SELECT 1
          FROM chat_threads ct
          WHERE ct.id = "buffer_object_cleanup_intents".chat_thread_id
            AND ct.organization_id =
              "buffer_object_cleanup_intents".organization_id
            AND ct.user_id =
              (SELECT pg_catalog.current_setting('app.user_id', true))
            AND (
              (
                "buffer_object_cleanup_intents".workspace_id IS NULL
                AND ct.workspace_id IS NULL
                AND pg_catalog.cardinality(ct.data_workspace_ids) = 0
              )
              OR (
                "buffer_object_cleanup_intents".workspace_id IS NOT NULL
                AND (
                  ct.workspace_id =
                    "buffer_object_cleanup_intents".workspace_id
                  OR ct.data_workspace_ids @>
                    ARRAY["buffer_object_cleanup_intents".workspace_id]::uuid[]
                )
              )
            )
        )
      )
      OR (
        chat_thread_id IS NULL
        AND workspace_id IS NOT NULL
        AND CASE
          WHEN workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          ) THEN true
          ELSE workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
        AND pg_catalog.split_part(object_key, '/', 1) = organization_id
        AND pg_catalog.split_part(object_key, '/', 2) = workspace_id::text
      )
    )
    OR (
      chat_thread_id IS NULL
      AND workspace_id IS NULL
      AND pg_catalog.split_part(object_key, '/', 1) = organization_id
      AND pg_catalog.split_part(object_key, '/', 2) = 'templates'
      AND pg_catalog.split_part(object_key, '/', 4) ~
        '^write-[0-9a-f-]{36}[.]docx$'
      AND pg_catalog.array_length(
        pg_catalog.string_to_array(object_key, '/'),
        1
      ) = 4
      AND EXISTS (
        SELECT 1
        FROM templates t
        WHERE t.organization_id =
          "buffer_object_cleanup_intents".organization_id
          AND t.id::text = pg_catalog.split_part(object_key, '/', 3)
      )
    )
  )
);
