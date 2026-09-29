SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Names a chat thread's requests minted that later requests must read the
-- same way: ref bindings, retired ref spellings, and tool-call ids. Rows are
-- appended with the messages that show them and never change, so the table
-- grants no UPDATE or DELETE and has no policy for them; a thread's rows go
-- with it through the cascading foreign key.
CREATE TABLE "chat_thread_names" (
	"thread_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"target" jsonb,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_names_pkey" PRIMARY KEY ("thread_id", "kind", "name"),
	CONSTRAINT "chat_thread_names_kind_values_check" CHECK ("kind" IN ('ref-binding', 'retired-ref', 'tool-call-id', 'ledger-start')),
	CONSTRAINT "chat_thread_names_target_check" CHECK (("kind" = 'ref-binding') = ("target" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "chat_thread_names" ADD CONSTRAINT "chat_thread_names_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_thread_names" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The table owner writes nothing here, so forced row security leaves it no
-- policy of its own.
ALTER TABLE "chat_thread_names" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "chat_thread_names" TO stella;--> statement-breakpoint
CREATE POLICY "chat_thread_name_select" ON "chat_thread_names" AS PERMISSIVE FOR SELECT TO "stella" USING (
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_names.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR CASE
  WHEN ct.workspace_id = ANY(
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
  ELSE ct.workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END)
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
CREATE POLICY "chat_thread_name_insert" ON "chat_thread_names" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_names.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR CASE
  WHEN ct.workspace_id = ANY(
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
  ELSE ct.workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END)
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
);
