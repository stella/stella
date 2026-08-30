SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - this metadata-only change narrows the existing user-owned policy so file visibility also follows the owning chat thread's organization, workspace, and embedded-data scope. Every existing row has a non-null owning-thread foreign key, and scoped application flows already operate inside that thread's scope. Rollback is a forward ALTER POLICY restoring the prior user-only predicate if required.
ALTER POLICY "user_select" ON "user_files" USING (
  user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = user_files.thread_id
      AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND ct.organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR CASE
          WHEN ct.workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          )
          THEN true
          ELSE ct.workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
      )
  )
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - inserts retain the authenticated-user check and additionally require a visible owning thread, preventing a file from being attached outside the current chat scope. Rollback is the forward policy restoration described above.
ALTER POLICY "user_insert" ON "user_files" WITH CHECK (
  user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = user_files.thread_id
      AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND ct.organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR CASE
          WHEN ct.workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          )
          THEN true
          ELSE ct.workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
      )
  )
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - updates keep the prior authenticated-user predicate for both old and new rows, then require the owning thread to remain visible before and after mutation. This prevents cross-scope reparenting while preserving metadata updates in visible chats. Rollback is the forward policy restoration described above.
ALTER POLICY "user_update" ON "user_files" USING (
  user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = user_files.thread_id
      AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND ct.organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR CASE
          WHEN ct.workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          )
          THEN true
          ELSE ct.workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
      )
  )
) WITH CHECK (
  user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = user_files.thread_id
      AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND ct.organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR CASE
          WHEN ct.workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          )
          THEN true
          ELSE ct.workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
      )
  )
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - deletes remain user-owned and are additionally limited to files whose owning thread is visible in the current chat scope. Root account and organization teardown transactions do not use the stella role. Rollback is the forward policy restoration described above.
ALTER POLICY "user_delete" ON "user_files" USING (
  user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
  AND EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = user_files.thread_id
      AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND ct.organization_id = (SELECT pg_catalog.current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR CASE
          WHEN ct.workspace_id = ANY(
            COALESCE(
              NULLIF(
                (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                ''
              )::uuid[],
              ARRAY[]::uuid[]
            )
          )
          THEN true
          ELSE ct.workspace_id IN (
            SELECT aw.authorized_workspace_id
            FROM public.stella_authorized_workspaces aw
          )
        END
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(ct.data_workspace_ids) AS scoped_workspace(workspace_id)
          WHERE scoped_workspace.workspace_id IS NULL
            OR NOT (
              scoped_workspace.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.stella_authorized_workspaces aw
                WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
                  AND aw.workspace_status <> 'deleting'
              )
            )
        )
      )
  )
);
