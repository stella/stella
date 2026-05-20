CREATE TABLE "file_chat_threads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "chat_thread_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "file_chat_threads_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE cascade,
  CONSTRAINT "file_chat_threads_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE cascade,
  CONSTRAINT "file_chat_threads_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id")
    ON DELETE cascade,
  CONSTRAINT "file_chat_threads_chat_thread_id_chat_threads_id_fk"
    FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id")
    ON DELETE cascade,
  CONSTRAINT "file_chat_threads_entity_id_workspace_id_entities_id_workspace_id_fk"
    FOREIGN KEY ("entity_id", "workspace_id")
    REFERENCES "entities"("id", "workspace_id")
    ON DELETE cascade,
  CONSTRAINT "file_chat_threads_field_id_workspace_id_fields_id_workspace_id_fk"
    FOREIGN KEY ("field_id", "workspace_id")
    REFERENCES "fields"("id", "workspace_id")
    ON DELETE cascade
);

ALTER TABLE "file_chat_threads" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "file_chat_threads_scope_uidx"
  ON "file_chat_threads" (
    "organization_id",
    "workspace_id",
    "user_id",
    "entity_id",
    "field_id"
  );

CREATE UNIQUE INDEX "file_chat_threads_chat_thread_id_uidx"
  ON "file_chat_threads" ("chat_thread_id");

CREATE INDEX "file_chat_threads_workspace_entity_field_idx"
  ON "file_chat_threads" ("workspace_id", "entity_id", "field_id");

CREATE POLICY "file_chat_thread_select" ON "file_chat_threads"
  FOR SELECT TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY "file_chat_thread_insert" ON "file_chat_threads"
  FOR INSERT TO "stella"
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY "file_chat_thread_update" ON "file_chat_threads"
  FOR UPDATE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY "file_chat_thread_delete" ON "file_chat_threads"
  FOR DELETE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "file_chat_threads" TO stella;
