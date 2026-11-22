SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- Automatic renames of newly uploaded documents from the organization's
-- naming pattern, in matters that opt in (#3294). A run cascades with the
-- processing run, entity version and document it names.
ALTER TABLE "organization_settings" ADD COLUMN "document_name_pattern" varchar(128);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "document_naming_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "document_naming_runs" (
	"entity_feature_gate" text DEFAULT 'pending' NOT NULL,
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"source_name" varchar(512) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"error_code" varchar(128),
	"skipped_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_source_run_fk" FOREIGN KEY ("id") REFERENCES "document_processing_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_naming_runs" ADD CONSTRAINT "document_naming_runs_version_entity_workspace_fk" FOREIGN KEY ("entity_version_id","entity_id","workspace_id") REFERENCES "entity_versions"("id","entity_id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "document_naming_runs_entity_workspace_idx" ON "document_naming_runs" ("entity_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_naming_runs_version_entity_workspace_uidx" ON "document_naming_runs" ("entity_version_id","entity_id","workspace_id");--> statement-breakpoint
CREATE INDEX "document_naming_runs_workspace_organization_idx" ON "document_naming_runs" ("workspace_id","organization_id");--> statement-breakpoint
CREATE INDEX "document_naming_runs_pending_idx" ON "document_naming_runs" ("updated_at","id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "document_naming_runs_running_idx" ON "document_naming_runs" ("claimed_at","id") WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "document_naming_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_naming_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_naming_runs" TO stella;--> statement-breakpoint
CREATE POLICY "document_naming_runs_owner" ON "document_naming_runs" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.document_naming_runs'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.document_naming_runs'::regclass));--> statement-breakpoint
CREATE POLICY "document_naming_runs_workspace_select" ON "document_naming_runs" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  CASE
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
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "document_naming_runs_workspace_insert" ON "document_naming_runs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  CASE
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
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "document_naming_runs_workspace_update" ON "document_naming_runs" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  CASE
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
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "document_naming_runs_workspace_delete" ON "document_naming_runs" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  CASE
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
END AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))
));
