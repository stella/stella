SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Messages a member queued in a chat thread, sent by the server as the member
-- once the thread's turn ends. Both tables are new and empty, so their
-- indexes are built here; nothing existing changes.
CREATE TABLE "chat_queued_messages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid,
  "user_id" text NOT NULL,
  "thread_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "request" jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_queued_messages_position_check" CHECK ("chat_queued_messages"."position" >= 1),
  CONSTRAINT "chat_queued_messages_revision_check" CHECK ("chat_queued_messages"."revision" >= 0)
);--> statement-breakpoint
CREATE TABLE "chat_queue_holds" (
  "thread_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid,
  "user_id" text NOT NULL,
  "reason" text NOT NULL,
  "turn_id" uuid,
  "queued_message_id" uuid,
  "refusal_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_queue_holds_reason_values_check" CHECK ("chat_queue_holds"."reason" IN ('turn-failed', 'turn-interrupted', 'member', 'send-refused', 'usage-limit', 'computer-away')),
  CONSTRAINT "chat_queue_holds_reason_payload_check" CHECK (CASE "chat_queue_holds"."reason"
        WHEN 'send-refused' THEN
          "chat_queue_holds"."queued_message_id" IS NOT NULL AND "chat_queue_holds"."refusal_code" IS NOT NULL
        ELSE
          "chat_queue_holds"."queued_message_id" IS NULL AND "chat_queue_holds"."refusal_code" IS NULL
      END)
);--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_thread_id_chat_threads_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_thread_id_chat_threads_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_queue_holds" ADD CONSTRAINT "chat_queue_holds_turn_id_chat_turns_id_fk"
  FOREIGN KEY ("turn_id") REFERENCES "chat_turns"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "chat_queued_messages_org_user_thread_position_idx"
  ON "chat_queued_messages" ("organization_id", "user_id", "thread_id", "position");--> statement-breakpoint
CREATE INDEX "chat_queued_messages_thread_id_idx"
  ON "chat_queued_messages" ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_queue_holds_org_user_idx"
  ON "chat_queue_holds" ("organization_id", "user_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_queued_messages" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_queue_holds" TO stella;--> statement-breakpoint

CREATE POLICY "chat_queued_message_select" ON "chat_queued_messages" AS PERMISSIVE FOR SELECT TO "stella"
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
    WHERE ct.id = chat_queued_messages.thread_id
      AND ct.user_id = chat_queued_messages.user_id
      AND ct.organization_id = chat_queued_messages.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queued_messages.workspace_id
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
CREATE POLICY "chat_queued_message_insert" ON "chat_queued_messages" AS PERMISSIVE FOR INSERT TO "stella"
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
    WHERE ct.id = chat_queued_messages.thread_id
      AND ct.user_id = chat_queued_messages.user_id
      AND ct.organization_id = chat_queued_messages.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queued_messages.workspace_id
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
CREATE POLICY "chat_queued_message_update" ON "chat_queued_messages" AS PERMISSIVE FOR UPDATE TO "stella"
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
    WHERE ct.id = chat_queued_messages.thread_id
      AND ct.user_id = chat_queued_messages.user_id
      AND ct.organization_id = chat_queued_messages.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queued_messages.workspace_id
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
    WHERE ct.id = chat_queued_messages.thread_id
      AND ct.user_id = chat_queued_messages.user_id
      AND ct.organization_id = chat_queued_messages.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queued_messages.workspace_id
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
CREATE POLICY "chat_queued_message_delete" ON "chat_queued_messages" AS PERMISSIVE FOR DELETE TO "stella"
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
    WHERE ct.id = chat_queued_messages.thread_id
      AND ct.user_id = chat_queued_messages.user_id
      AND ct.organization_id = chat_queued_messages.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queued_messages.workspace_id
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
CREATE POLICY "chat_queue_hold_select" ON "chat_queue_holds" AS PERMISSIVE FOR SELECT TO "stella"
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
    WHERE ct.id = chat_queue_holds.thread_id
      AND ct.user_id = chat_queue_holds.user_id
      AND ct.organization_id = chat_queue_holds.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queue_holds.workspace_id
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
CREATE POLICY "chat_queue_hold_insert" ON "chat_queue_holds" AS PERMISSIVE FOR INSERT TO "stella"
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
    WHERE ct.id = chat_queue_holds.thread_id
      AND ct.user_id = chat_queue_holds.user_id
      AND ct.organization_id = chat_queue_holds.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queue_holds.workspace_id
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
CREATE POLICY "chat_queue_hold_update" ON "chat_queue_holds" AS PERMISSIVE FOR UPDATE TO "stella"
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
    WHERE ct.id = chat_queue_holds.thread_id
      AND ct.user_id = chat_queue_holds.user_id
      AND ct.organization_id = chat_queue_holds.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queue_holds.workspace_id
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
    WHERE ct.id = chat_queue_holds.thread_id
      AND ct.user_id = chat_queue_holds.user_id
      AND ct.organization_id = chat_queue_holds.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queue_holds.workspace_id
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
CREATE POLICY "chat_queue_hold_delete" ON "chat_queue_holds" AS PERMISSIVE FOR DELETE TO "stella"
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
    WHERE ct.id = chat_queue_holds.thread_id
      AND ct.user_id = chat_queue_holds.user_id
      AND ct.organization_id = chat_queue_holds.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_queue_holds.workspace_id
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
CREATE POLICY "chat_queued_messages_owner_access" ON "chat_queued_messages" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_queued_messages'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_queued_messages'::regclass));--> statement-breakpoint
CREATE POLICY "chat_queue_holds_owner_access" ON "chat_queue_holds" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_queue_holds'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_queue_holds'::regclass));
