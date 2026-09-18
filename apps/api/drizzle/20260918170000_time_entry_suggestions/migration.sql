SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "time_entry_suggestions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "date_worked" date NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "status" text NOT NULL,
  "time_entry_id" uuid,
  "evidence" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "time_entry_suggestions_status_check" CHECK ("status" in ('accepted', 'dismissed')),
  CONSTRAINT "time_entry_suggestions_accepted_entry_check" CHECK ("status" <> 'accepted' OR "time_entry_id" IS NOT NULL OR "evidence" IS NOT NULL),
  CONSTRAINT "time_entry_suggestions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "time_entry_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade,
  CONSTRAINT "time_entry_suggestions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "time_entry_suggestions_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "time_entries"("id") ON DELETE set null,
  CONSTRAINT "time_entry_suggestions_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "time_entry_suggestions_ws_user_fingerprint_uidx" ON "time_entry_suggestions" ("workspace_id", "user_id", "fingerprint");--> statement-breakpoint
CREATE INDEX "time_entry_suggestions_ws_user_date_idx" ON "time_entry_suggestions" ("workspace_id", "user_id", "date_worked");--> statement-breakpoint
ALTER TABLE "time_entry_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "time_entry_suggestions_user_select"
  ON "time_entry_suggestions" AS PERMISSIVE FOR SELECT TO stella
  USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND (
  (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  ))
)
));--> statement-breakpoint
CREATE POLICY "time_entry_suggestions_user_insert"
  ON "time_entry_suggestions" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND (
  (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  ))
)
));--> statement-breakpoint
CREATE POLICY "time_entry_suggestions_user_update"
  ON "time_entry_suggestions" AS PERMISSIVE FOR UPDATE TO stella
  USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND (
  (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  ))
)
));--> statement-breakpoint
CREATE POLICY "time_entry_suggestions_user_delete"
  ON "time_entry_suggestions" AS PERMISSIVE FOR DELETE TO stella
  USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND (
  (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  ))
)
));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "time_entry_suggestions" TO "stella";
