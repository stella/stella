-- Durable document processing state. Every row belongs to one immutable
-- source file/version/field and can be replayed safely by the queue worker.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "document_processing_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "field_id" uuid NOT NULL,
  "source_file_id" uuid NOT NULL,
  "source_sha256_hex" varchar(64) NOT NULL,
  "kind" text NOT NULL,
  "processor_version" integer DEFAULT 1 NOT NULL,
  "request_source" text NOT NULL,
  "requested_by" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "progress_completed" integer DEFAULT 0 NOT NULL,
  "progress_total" integer,
  "error_code" varchar(128),
  "error_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "claimed_by" varchar(128),
  "next_attempt_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_processing_runs_kind_values_check"
    CHECK ("kind" IN ('ocr')),
  CONSTRAINT "document_processing_runs_status_values_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "document_processing_runs_request_source_values_check"
    CHECK ("request_source" IN ('upload', 'manual', 'repair')),
  CONSTRAINT "document_processing_runs_processor_version_positive_check"
    CHECK ("processor_version" > 0),
  CONSTRAINT "document_processing_runs_attempt_count_nonnegative_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "document_processing_runs_progress_nonnegative_check"
    CHECK ("progress_completed" >= 0 AND ("progress_total" IS NULL OR "progress_total" >= 0)),
  CONSTRAINT "document_processing_runs_progress_within_total_check"
    CHECK ("progress_total" IS NULL OR "progress_completed" <= "progress_total"),
  CONSTRAINT "document_processing_runs_source_sha256_hex_check"
    CHECK ("source_sha256_hex" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "document_processing_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_version_fk"
  FOREIGN KEY ("entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_field_workspace_fk"
  FOREIGN KEY ("field_id", "workspace_id") REFERENCES "fields"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_processing_runs_source_uidx"
  ON "document_processing_runs" ("organization_id", "kind", "entity_version_id", "field_id", "source_file_id", "source_sha256_hex", "processor_version");--> statement-breakpoint
CREATE INDEX "document_processing_runs_org_status_next_attempt_idx"
  ON "document_processing_runs" ("organization_id", "status", "next_attempt_at", "created_at", "id");--> statement-breakpoint
CREATE INDEX "document_processing_runs_workspace_created_idx"
  ON "document_processing_runs" ("workspace_id", "created_at" DESC, "id");--> statement-breakpoint
CREATE INDEX "document_processing_runs_workspace_entity_created_idx"
  ON "document_processing_runs" ("workspace_id", "entity_id", "created_at" DESC, "id");--> statement-breakpoint
CREATE INDEX "document_processing_runs_queued_schedule_idx"
  ON "document_processing_runs" ("next_attempt_at", "created_at", "id")
  WHERE "status" = 'queued';--> statement-breakpoint
CREATE INDEX "document_processing_runs_running_lease_idx"
  ON "document_processing_runs" ("claimed_at", "id")
  WHERE "status" = 'running';--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_processing_runs" TO stella;--> statement-breakpoint
CREATE POLICY "document_processing_runs_workspace_select" ON "document_processing_runs" AS PERMISSIVE FOR SELECT TO "stella" USING ((CASE
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
CREATE POLICY "document_processing_runs_no_insert" ON "document_processing_runs" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "document_processing_runs_no_update" ON "document_processing_runs" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "document_processing_runs_no_delete" ON "document_processing_runs" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
