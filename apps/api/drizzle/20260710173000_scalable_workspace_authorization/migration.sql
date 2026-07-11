SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The Bun/Drizzle migrator runs all pending migrations in one transaction.
-- Keep this migration transactional: committing inside its callback closes the
-- driver's scoped connection before Drizzle can write its bookkeeping row.
-- The existing member_userId_idx bounds the current-user membership lookup;
-- filtering that small result by organization does not justify a blocking
-- composite-index build in this migration.

CREATE OR REPLACE VIEW public.stella_authorized_workspaces
WITH (security_barrier = true, security_invoker = false)
AS
WITH current_member AS (
  SELECT m.organization_id, m.user_id, m.role
  FROM public.member m
  WHERE pg_catalog.current_setting(
      'app.workspace_access_mode',
      true
    ) = 'membership'
    AND m.organization_id = NULLIF(
      pg_catalog.current_setting('app.organization_id', true),
      ''
    )
    AND m.user_id = NULLIF(
      pg_catalog.current_setting('app.user_id', true),
      ''
    )
)
SELECT
  explicit_workspace.workspace_id AS authorized_workspace_id,
  w.status AS workspace_status
FROM pg_catalog.unnest(
  COALESCE(
    NULLIF(
      pg_catalog.current_setting('app.workspace_ids', true),
      ''
    )::uuid[],
    ARRAY[]::uuid[]
  )
) AS explicit_workspace(workspace_id)
LEFT JOIN public.workspaces w
  ON w.id = explicit_workspace.workspace_id
WHERE explicit_workspace.workspace_id IS NOT NULL
UNION ALL
SELECT w.id AS authorized_workspace_id, w.status AS workspace_status
FROM current_member m
JOIN public.workspace_members wm
  ON wm.user_id = m.user_id
JOIN public.workspaces w
  ON w.id = wm.workspace_id
 AND w.organization_id = m.organization_id
UNION ALL
SELECT w.id AS authorized_workspace_id, w.status AS workspace_status
FROM current_member m
JOIN public.workspaces w
  ON w.organization_id = m.organization_id
 AND w.client_id IS NOT NULL
WHERE m.role IN ('owner', 'admin');--> statement-breakpoint

REVOKE ALL ON TABLE public.stella_authorized_workspaces FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE public.stella_authorized_workspaces TO stella;--> statement-breakpoint
-- The view and every updated policy remain compatible with the old
-- API's explicit app.workspace_ids scope, so old application instances remain
-- compatible while the migration transaction is in flight.
DO $$
DECLARE
  policy_expression text;
  policy_row record;
  workspace_access_template constant text := $predicate$
    CASE
      WHEN %1$s = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE %1$s IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  $predicate$;
BEGIN
  FOR policy_row IN
    SELECT tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename <> 'workspaces'
      AND policyname IN (
        'workspace_select',
        'workspace_insert',
        'workspace_update',
        'workspace_delete'
      )
    ORDER BY tablename, policyname
  LOOP
    policy_expression := format(workspace_access_template, 'workspace_id');

    IF policy_row.policyname = 'workspace_insert' THEN
      EXECUTE format(
        'ALTER POLICY %I ON public.%I WITH CHECK (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON public.%I USING (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
-- Workspaces and deleted-user visibility use their existing specialized policies.

ALTER POLICY "workspace_select" ON "workspaces"
  USING (
    CASE
      WHEN id = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  );--> statement-breakpoint
ALTER POLICY "workspace_update" ON "workspaces"
  USING (
    CASE
      WHEN id = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  );--> statement-breakpoint
ALTER POLICY "workspace_delete" ON "workspaces"
  USING (
    CASE
      WHEN id = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE id IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  );
--> statement-breakpoint

ALTER POLICY "auth_user_select" ON "user"
USING (
  id = (SELECT current_setting('app.user_id', true))
  OR EXISTS (
    SELECT 1
    FROM member m
    WHERE m.user_id = "user".id
      AND m.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
  )
  OR (
    "user".deleted_at IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM task_assignees ta
        JOIN workspaces w ON w.id = ta.workspace_id
        WHERE ta.user_id = "user".id
          AND (
            CASE
              WHEN ta.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              THEN true
              ELSE ta.workspace_id IN (
                SELECT aw.authorized_workspace_id
                FROM public.stella_authorized_workspaces aw
              )
            END
          )
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM entities e
        JOIN workspaces w ON w.id = e.workspace_id
        WHERE (e.created_by = "user".id OR e.last_edited_by = "user".id)
          AND (
            CASE
              WHEN e.workspace_id = ANY(
                COALESCE(
                  NULLIF(
                    (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
                    ''
                  )::uuid[],
                  ARRAY[]::uuid[]
                )
              )
              THEN true
              ELSE e.workspace_id IN (
                SELECT aw.authorized_workspace_id
                FROM public.stella_authorized_workspaces aw
              )
            END
          )
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
    )
  )
);--> statement-breakpoint

-- Chat policies have additional ownership and embedded-data constraints.

DO $$
DECLARE
  active_workspace_array_template constant text := $predicate$
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(%s) AS scoped_workspace(workspace_id)
      WHERE scoped_workspace.workspace_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.stella_authorized_workspaces aw
          WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
            AND aw.workspace_status <> 'deleting'
        )
    )
  $predicate$;
  policy_expression text;
  policy_row record;
  workspace_access_template constant text := $predicate$
    CASE
      WHEN %1$s = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE %1$s IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  $predicate$;
BEGIN
  FOR policy_row IN
    SELECT tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename = 'chat_threads' AND policyname IN (
          'chat_thread_select',
          'chat_thread_insert',
          'chat_thread_update',
          'chat_thread_delete'
        ))
        OR (tablename = 'chat_messages' AND policyname IN (
          'chat_message_select',
          'chat_message_insert',
          'chat_message_update',
          'chat_message_delete'
        ))
        OR (tablename = 'file_chat_threads' AND policyname IN (
          'file_chat_thread_select',
          'file_chat_thread_insert',
          'file_chat_thread_update',
          'file_chat_thread_delete'
        ))
      )
    ORDER BY tablename, policyname
  LOOP
    IF policy_row.tablename = 'chat_threads' THEN
      policy_expression := format(
        'user_id = (SELECT current_setting(''app.user_id'', true)) AND organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (workspace_id IS NULL OR %s) AND (cardinality(data_workspace_ids) = 0 OR %s)',
        format(workspace_access_template, 'workspace_id'),
        format(active_workspace_array_template, 'data_workspace_ids')
      );
    ELSIF policy_row.tablename = 'chat_messages' THEN
      policy_expression := format(
        'user_id = (SELECT current_setting(''app.user_id'', true)) AND (workspace_id IS NULL OR %s) AND EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_messages.thread_id AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (cardinality(ct.data_workspace_ids) = 0 OR %s))',
        format(workspace_access_template, 'workspace_id'),
        format(active_workspace_array_template, 'ct.data_workspace_ids')
      );
    ELSE
      policy_expression := format(
        'user_id = (SELECT current_setting(''app.user_id'', true)) AND organization_id = (SELECT current_setting(''app.organization_id'', true)) AND %s',
        format(workspace_access_template, 'workspace_id')
      );
    END IF;

    IF policy_row.policyname LIKE '%_insert' THEN
      EXECUTE format(
        'ALTER POLICY %I ON public.%I WITH CHECK (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON public.%I USING (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

-- Derived chat tables inherit the owning thread's constraints.

DO $$
DECLARE
  active_workspace_array_template constant text := $predicate$
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(%s) AS scoped_workspace(workspace_id)
      WHERE scoped_workspace.workspace_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.stella_authorized_workspaces aw
          WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
            AND aw.workspace_status <> 'deleting'
        )
    )
  $predicate$;
  owner_thread_id text;
  policy_expression text;
  policy_row record;
  workspace_access_template constant text := $predicate$
    CASE
      WHEN %1$s = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      THEN true
      ELSE %1$s IN (
        SELECT aw.authorized_workspace_id
        FROM public.stella_authorized_workspaces aw
      )
    END
  $predicate$;
BEGIN
  FOR policy_row IN
    SELECT tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename = 'chat_thread_search_documents' AND policyname IN (
          'chat_thread_search_document_select',
          'chat_thread_search_document_insert',
          'chat_thread_search_document_update',
          'chat_thread_search_document_delete'
        ))
        OR (tablename = 'chat_message_search_documents' AND policyname IN (
          'chat_message_search_document_select',
          'chat_message_search_document_insert',
          'chat_message_search_document_update',
          'chat_message_search_document_delete'
        ))
        OR (tablename = 'chat_thread_compactions' AND policyname IN (
          'chat_thread_compaction_select',
          'chat_thread_compaction_insert',
          'chat_thread_compaction_update',
          'chat_thread_compaction_delete'
        ))
      )
    ORDER BY tablename, policyname
  LOOP
    IF policy_row.tablename = 'chat_thread_search_documents' THEN
      owner_thread_id := 'chat_thread_search_documents.thread_id';
    ELSIF policy_row.tablename = 'chat_message_search_documents' THEN
      owner_thread_id := 'chat_message_search_documents.thread_id';
    ELSE
      owner_thread_id := 'chat_thread_compactions.thread_id';
    END IF;

    policy_expression := format(
      'EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = %s AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR %s) AND (cardinality(ct.data_workspace_ids) = 0 OR %s))',
      owner_thread_id,
      format(workspace_access_template, 'ct.workspace_id'),
      format(active_workspace_array_template, 'ct.data_workspace_ids')
    );

    IF policy_row.policyname LIKE '%_insert' THEN
      EXECUTE format(
        'ALTER POLICY %I ON public.%I WITH CHECK (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON public.%I USING (%s)',
        policy_row.policyname,
        policy_row.tablename,
        policy_expression
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

-- Do not leak this migration's fail-fast DDL limits into later migrations
-- that Drizzle may execute in the same outer transaction.
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
