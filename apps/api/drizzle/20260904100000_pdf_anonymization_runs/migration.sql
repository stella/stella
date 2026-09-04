SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "pdf_anonymization_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "source_file_id" uuid NOT NULL,
  "source_file_name" varchar(1024) NOT NULL,
  "source_mime_type" varchar(256) NOT NULL,
  "source_sha256_hex" varchar(64) NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error_code" varchar(64),
  "page_count" integer,
  "detection_count" integer,
  "certificate" jsonb,
  "output_entity_id" uuid,
  "output_field_id" uuid,
  "output_file_name" varchar(1024),
  "requested_by" text,
  "pipeline_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "pdf_anonymization_runs_id_workspace_organization_unq"
    UNIQUE("id", "workspace_id", "organization_id"),
  CONSTRAINT "pdf_anonymization_runs_status_values_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT "pdf_anonymization_runs_error_code_values_check"
    CHECK ("error_code" IS NULL OR "error_code" IN ('encrypted_pdf', 'invalid_pdf', 'ocr_not_configured', 'ocr_failed', 'source_changed', 'rewrite_failed', 'output_rejected', 'internal')),
  CONSTRAINT "pdf_anonymization_runs_source_mime_type_check"
    CHECK ("source_mime_type" = 'application/pdf'),
  CONSTRAINT "pdf_anonymization_runs_source_sha256_hex_check"
    CHECK ("source_sha256_hex" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pdf_anonymization_runs_pipeline_version_check"
    CHECK ("pipeline_version" > 0),
  CONSTRAINT "pdf_anonymization_runs_counts_check"
    CHECK (("page_count" IS NULL OR "page_count" >= 1) AND ("detection_count" IS NULL OR "detection_count" >= 0))
);--> statement-breakpoint

ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "public"."entities"("id", "workspace_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_version_fk"
  FOREIGN KEY ("entity_version_id") REFERENCES "public"."entity_versions"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_field_workspace_fk"
  FOREIGN KEY ("file_field_id", "workspace_id")
  REFERENCES "public"."fields"("id", "workspace_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_anonymization_runs"
  ADD CONSTRAINT "pdf_anonymization_runs_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "pdf_anonymization_runs_document_created_idx"
  ON "pdf_anonymization_runs" ("workspace_id", "entity_id", "file_field_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_anonymization_runs_active_document_uidx"
  ON "pdf_anonymization_runs" ("workspace_id", "entity_id", "file_field_id")
  WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "pdf_anonymization_runs_queued_created_idx"
  ON "pdf_anonymization_runs" ("created_at", "id")
  WHERE "status" = 'queued';--> statement-breakpoint
CREATE INDEX "pdf_anonymization_runs_running_started_idx"
  ON "pdf_anonymization_runs" ("started_at", "id")
  WHERE "status" = 'running';--> statement-breakpoint

ALTER TABLE "pdf_anonymization_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pdf_anonymization_runs" TO stella;--> statement-breakpoint

CREATE POLICY "pdf_anonymization_runs_workspace_select" ON "pdf_anonymization_runs" AS PERMISSIVE FOR SELECT TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "pdf_anonymization_runs_workspace_insert" ON "pdf_anonymization_runs" AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "pdf_anonymization_runs_workspace_update" ON "pdf_anonymization_runs" AS PERMISSIVE FOR UPDATE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "pdf_anonymization_runs_workspace_delete" ON "pdf_anonymization_runs" AS PERMISSIVE FOR DELETE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));
