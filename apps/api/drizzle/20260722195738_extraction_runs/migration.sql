SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" text,
	"scope" text NOT NULL,
	"execution_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_runs_execution_version_positive_check" CHECK ("execution_version" > 0),
	CONSTRAINT "extraction_runs_scope_values_check" CHECK ("scope" IN ('workspace', 'entities', 'properties', 'cells')),
	CONSTRAINT "extraction_runs_status_values_check" CHECK ("status" IN ('planning', 'running', 'finalizing', 'completed', 'failed', 'skipped')),
	CONSTRAINT "extraction_runs_progress_nonnegative_check" CHECK ("total" >= 0 AND "completed" >= 0),
	CONSTRAINT "extraction_runs_completed_within_total_check" CHECK ("completed" <= "total")
);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "extraction_runs_workspace_created_idx" ON "extraction_runs" ("workspace_id", "created_at" DESC NULLS LAST, "id");--> statement-breakpoint
CREATE INDEX "extraction_runs_workspace_active_idx" ON "extraction_runs" ("workspace_id", "updated_at") WHERE "status" IN ('planning', 'running', 'finalizing');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extraction_runs" TO stella;--> statement-breakpoint
CREATE POLICY "extraction_runs_workspace_select" ON "extraction_runs" AS PERMISSIVE FOR SELECT TO "stella" USING ((CASE
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
END) AND organization_id = (SELECT current_setting(
  'app.organization_id', true
)));--> statement-breakpoint
CREATE POLICY "extraction_runs_workspace_insert" ON "extraction_runs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((CASE
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
END) AND organization_id = (SELECT current_setting(
  'app.organization_id', true
)));--> statement-breakpoint
CREATE POLICY "extraction_runs_workspace_update" ON "extraction_runs" AS PERMISSIVE FOR UPDATE TO "stella" USING ((CASE
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
END) AND organization_id = (SELECT current_setting(
  'app.organization_id', true
)));--> statement-breakpoint
CREATE POLICY "extraction_runs_workspace_delete" ON "extraction_runs" AS PERMISSIVE FOR DELETE TO "stella" USING ((CASE
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
END) AND organization_id = (SELECT current_setting(
  'app.organization_id', true
)));
