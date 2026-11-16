SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Receipts of the chat commands (sends, answers) a member's client sent with an
-- id of its own, so a retry after a lost response learns the turn the first
-- attempt started instead of acting twice. The table is new and empty, so its
-- indexes are built here; nothing existing changes.
CREATE TABLE "chat_command_receipts" (
  "command_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid,
  "user_id" text NOT NULL,
  "thread_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "command_type" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_command_receipts_command_type_check" CHECK ("chat_command_receipts"."command_type" IN ('send', 'answer'))
);--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_thread_id_chat_threads_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_turn_id_chat_turns_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "chat_turns"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_command_receipts" ADD CONSTRAINT "chat_command_receipts_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "chat_command_receipts_accepted_at_idx"
  ON "chat_command_receipts" ("accepted_at");--> statement-breakpoint
CREATE INDEX "chat_command_receipts_thread_id_idx"
  ON "chat_command_receipts" ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_command_receipts_turn_id_idx"
  ON "chat_command_receipts" ("turn_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_command_receipts" TO stella;--> statement-breakpoint

CREATE POLICY "chat_command_receipt_select" ON "chat_command_receipts" AS PERMISSIVE FOR SELECT TO "stella"
  USING (
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND
  (workspace_id IS NULL OR CASE
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
END) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_command_receipts.thread_id
      AND ct.user_id = chat_command_receipts.user_id
      AND ct.organization_id = chat_command_receipts.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_command_receipts.workspace_id
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
            (SELECT pg_catalog.current_setting(
              'app.workspace_ids', true
            )),
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
CREATE POLICY "chat_command_receipt_insert" ON "chat_command_receipts" AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND
  (workspace_id IS NULL OR CASE
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
END) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_command_receipts.thread_id
      AND ct.user_id = chat_command_receipts.user_id
      AND ct.organization_id = chat_command_receipts.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_command_receipts.workspace_id
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
            (SELECT pg_catalog.current_setting(
              'app.workspace_ids', true
            )),
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
CREATE POLICY "chat_command_receipt_update" ON "chat_command_receipts" AS PERMISSIVE FOR UPDATE TO "stella"
  USING (
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND
  (workspace_id IS NULL OR CASE
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
END) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_command_receipts.thread_id
      AND ct.user_id = chat_command_receipts.user_id
      AND ct.organization_id = chat_command_receipts.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_command_receipts.workspace_id
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
            (SELECT pg_catalog.current_setting(
              'app.workspace_ids', true
            )),
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
)
  WITH CHECK (
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND
  (workspace_id IS NULL OR CASE
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
END) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_command_receipts.thread_id
      AND ct.user_id = chat_command_receipts.user_id
      AND ct.organization_id = chat_command_receipts.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_command_receipts.workspace_id
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
            (SELECT pg_catalog.current_setting(
              'app.workspace_ids', true
            )),
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
CREATE POLICY "chat_command_receipt_delete" ON "chat_command_receipts" AS PERMISSIVE FOR DELETE TO "stella"
  USING (
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND
  (workspace_id IS NULL OR CASE
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
END) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_command_receipts.thread_id
      AND ct.user_id = chat_command_receipts.user_id
      AND ct.organization_id = chat_command_receipts.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_command_receipts.workspace_id
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
            (SELECT pg_catalog.current_setting(
              'app.workspace_ids', true
            )),
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
CREATE POLICY "chat_command_receipts_owner_access" ON "chat_command_receipts" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_command_receipts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_command_receipts'::regclass));
