SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps migrations in a transaction; PostgreSQL requires concurrent
-- index builds to run outside it. Reopen the transaction before changing RLS.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = '0';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "member_organization_user_idx"
  ON "member" ("organization_id", "user_id");--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE OR REPLACE VIEW public.stella_authorized_workspaces
WITH (security_barrier = true, security_invoker = false)
AS
SELECT w.id AS workspace_id
FROM public.workspaces w
JOIN public.member m
  ON m.organization_id = w.organization_id
 AND m.user_id = NULLIF(
   pg_catalog.current_setting('app.user_id', true),
   ''
 )
WHERE w.organization_id = NULLIF(
  pg_catalog.current_setting('app.organization_id', true),
  ''
)
AND (
  EXISTS (
    SELECT 1
    FROM public.workspace_members wm
    WHERE wm.workspace_id = w.id
      AND wm.user_id = m.user_id
  )
  OR (m.role IN ('owner', 'admin') AND w.client_id IS NOT NULL)
);--> statement-breakpoint

REVOKE ALL ON TABLE public.stella_authorized_workspaces FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON TABLE public.stella_authorized_workspaces TO stella;--> statement-breakpoint

-- Keep this SQL function SECURITY INVOKER with no SET clause: PostgreSQL can
-- inline it into RLS predicates and plan the security-barrier view as a joined
-- access relation instead of executing a SECURITY DEFINER function per row.
CREATE OR REPLACE FUNCTION public.stella_workspace_is_authorized(
  target_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    target_workspace_id = ANY(
      COALESCE(
        NULLIF(
          pg_catalog.current_setting('app.workspace_ids', true),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    )
    OR (
      pg_catalog.current_setting('app.workspace_access_mode', true) = 'membership'
      AND EXISTS (
        SELECT 1
        FROM public.stella_authorized_workspaces aw
        WHERE aw.workspace_id = target_workspace_id
      )
    )
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_workspace_is_authorized(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_workspace_is_authorized(uuid) TO stella;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stella_workspace_array_is_authorized(
  target_workspace_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(target_workspace_ids) AS scoped_workspace(workspace_id)
    WHERE NOT public.stella_workspace_is_authorized(
      scoped_workspace.workspace_id
    )
  )
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_workspace_array_is_authorized(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_workspace_array_is_authorized(uuid[]) TO stella;--> statement-breakpoint

DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename <> 'workspaces'
      AND policyname IN (
        'workspace_select',
        'workspace_insert',
        'workspace_update',
        'workspace_delete'
      )
  LOOP
    IF policy_row.policyname = 'workspace_insert' THEN
      EXECUTE format(
        'ALTER POLICY %I ON public.%I WITH CHECK (public.stella_workspace_is_authorized(workspace_id))',
        policy_row.policyname,
        policy_row.tablename
      );
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON public.%I USING (public.stella_workspace_is_authorized(workspace_id))',
        policy_row.policyname,
        policy_row.tablename
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

ALTER POLICY "workspace_select" ON "workspaces"
  USING (public.stella_workspace_is_authorized(id));--> statement-breakpoint
ALTER POLICY "workspace_update" ON "workspaces"
  USING (public.stella_workspace_is_authorized(id));--> statement-breakpoint
ALTER POLICY "workspace_delete" ON "workspaces"
  USING (public.stella_workspace_is_authorized(id));
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
          AND public.stella_workspace_is_authorized(ta.workspace_id)
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM entities e
        JOIN workspaces w ON w.id = e.workspace_id
        WHERE (e.created_by = "user".id OR e.last_edited_by = "user".id)
          AND public.stella_workspace_is_authorized(e.workspace_id)
          AND w.organization_id = (
            SELECT current_setting('app.organization_id', true)
          )
      )
    )
  )
);--> statement-breakpoint

ALTER POLICY "chat_thread_select" ON "chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND (
    cardinality(data_workspace_ids) = 0
    OR public.stella_workspace_array_is_authorized(data_workspace_ids)
  )
);--> statement-breakpoint
ALTER POLICY "chat_thread_insert" ON "chat_threads"
WITH CHECK (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND (
    cardinality(data_workspace_ids) = 0
    OR public.stella_workspace_array_is_authorized(data_workspace_ids)
  )
);--> statement-breakpoint
ALTER POLICY "chat_thread_update" ON "chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND (
    cardinality(data_workspace_ids) = 0
    OR public.stella_workspace_array_is_authorized(data_workspace_ids)
  )
);--> statement-breakpoint
ALTER POLICY "chat_thread_delete" ON "chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND (
    cardinality(data_workspace_ids) = 0
    OR public.stella_workspace_array_is_authorized(data_workspace_ids)
  )
);--> statement-breakpoint

ALTER POLICY "chat_message_select" ON "chat_messages"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND EXISTS (
    SELECT 1
    FROM chat_threads ct
    WHERE ct.id = chat_messages.thread_id
      AND ct.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids)
      )
  )
);--> statement-breakpoint
ALTER POLICY "chat_message_insert" ON "chat_messages"
WITH CHECK (
  user_id = (SELECT current_setting('app.user_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND EXISTS (
    SELECT 1
    FROM chat_threads ct
    WHERE ct.id = chat_messages.thread_id
      AND ct.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids)
      )
  )
);--> statement-breakpoint
ALTER POLICY "chat_message_update" ON "chat_messages"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND EXISTS (
    SELECT 1
    FROM chat_threads ct
    WHERE ct.id = chat_messages.thread_id
      AND ct.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids)
      )
  )
);--> statement-breakpoint
ALTER POLICY "chat_message_delete" ON "chat_messages"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND (
    workspace_id IS NULL
    OR public.stella_workspace_is_authorized(workspace_id)
  )
  AND EXISTS (
    SELECT 1
    FROM chat_threads ct
    WHERE ct.id = chat_messages.thread_id
      AND ct.organization_id = (
        SELECT current_setting('app.organization_id', true)
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids)
      )
  )
);--> statement-breakpoint

ALTER POLICY "file_chat_thread_select" ON "file_chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND public.stella_workspace_is_authorized(workspace_id)
);--> statement-breakpoint
ALTER POLICY "file_chat_thread_insert" ON "file_chat_threads"
WITH CHECK (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND public.stella_workspace_is_authorized(workspace_id)
);--> statement-breakpoint
ALTER POLICY "file_chat_thread_update" ON "file_chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND public.stella_workspace_is_authorized(workspace_id)
);--> statement-breakpoint
ALTER POLICY "file_chat_thread_delete" ON "file_chat_threads"
USING (
  user_id = (SELECT current_setting('app.user_id', true))
  AND organization_id = (SELECT current_setting('app.organization_id', true))
  AND public.stella_workspace_is_authorized(workspace_id)
);--> statement-breakpoint

DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'chat_thread_search_documents',
        'chat_message_search_documents',
        'chat_thread_compactions'
      )
  LOOP
    IF policy_row.tablename = 'chat_thread_search_documents' THEN
      IF policy_row.policyname = 'chat_thread_search_document_insert' THEN
        EXECUTE format(
          'ALTER POLICY %I ON public.%I WITH CHECK (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_thread_search_documents.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      ELSE
        EXECUTE format(
          'ALTER POLICY %I ON public.%I USING (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_thread_search_documents.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      END IF;
    ELSIF policy_row.tablename = 'chat_message_search_documents' THEN
      IF policy_row.policyname = 'chat_message_search_document_insert' THEN
        EXECUTE format(
          'ALTER POLICY %I ON public.%I WITH CHECK (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_message_search_documents.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      ELSE
        EXECUTE format(
          'ALTER POLICY %I ON public.%I USING (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_message_search_documents.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      END IF;
    ELSE
      IF policy_row.policyname = 'chat_thread_compaction_insert' THEN
        EXECUTE format(
          'ALTER POLICY %I ON public.%I WITH CHECK (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_thread_compactions.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      ELSE
        EXECUTE format(
          'ALTER POLICY %I ON public.%I USING (EXISTS (SELECT 1 FROM chat_threads ct WHERE ct.id = chat_thread_compactions.thread_id AND ct.user_id = (SELECT current_setting(''app.user_id'', true)) AND ct.organization_id = (SELECT current_setting(''app.organization_id'', true)) AND (ct.workspace_id IS NULL OR public.stella_workspace_is_authorized(ct.workspace_id)) AND (cardinality(ct.data_workspace_ids) = 0 OR public.stella_workspace_array_is_authorized(ct.data_workspace_ids))))',
          policy_row.policyname,
          policy_row.tablename
        );
      END IF;
    END IF;
  END LOOP;
END
$$;
