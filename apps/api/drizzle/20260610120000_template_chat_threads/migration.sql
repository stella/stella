CREATE TABLE "template_chat_threads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "template_id" uuid NOT NULL,
  "chat_thread_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "template_chat_threads_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id")
    ON DELETE cascade,
  CONSTRAINT "template_chat_threads_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id")
    ON DELETE cascade,
  CONSTRAINT "template_chat_threads_chat_thread_id_chat_threads_id_fk"
    FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id")
    ON DELETE cascade,
  CONSTRAINT "template_chat_threads_template_id_organization_id_templates_id_organization_id_fk"
    FOREIGN KEY ("template_id", "organization_id")
    REFERENCES "templates"("id", "organization_id")
    ON DELETE cascade
);

ALTER TABLE "template_chat_threads" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "template_chat_threads_scope_uidx"
  ON "template_chat_threads" ("organization_id", "user_id", "template_id");

CREATE UNIQUE INDEX "template_chat_threads_chat_thread_id_uidx"
  ON "template_chat_threads" ("chat_thread_id");

CREATE POLICY "template_chat_thread_select" ON "template_chat_threads"
  FOR SELECT TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );

CREATE POLICY "template_chat_thread_insert" ON "template_chat_threads"
  FOR INSERT TO "stella"
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );

CREATE POLICY "template_chat_thread_update" ON "template_chat_threads"
  FOR UPDATE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );

CREATE POLICY "template_chat_thread_delete" ON "template_chat_threads"
  FOR DELETE TO "stella"
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "template_chat_threads" TO stella;
