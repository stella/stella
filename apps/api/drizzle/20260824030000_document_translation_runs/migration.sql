SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "document_translation_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "source_file_id" uuid NOT NULL,
  "source_file_name" varchar(1024) NOT NULL,
  "source_mime_type" varchar(256) NOT NULL,
  "output" text NOT NULL,
  "engine" text NOT NULL,
  "source_lang" varchar(16),
  "target_lang" varchar(16) NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error_code" varchar(64),
  "total" integer DEFAULT 0 NOT NULL,
  "completed" integer DEFAULT 0 NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "output_entity_id" uuid,
  "output_field_id" uuid,
  "output_file_name" varchar(1024),
  "requested_by" text,
  "model_ref" varchar(256),
  "pipeline_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "document_translation_runs_id_workspace_organization_unq"
    UNIQUE("id", "workspace_id", "organization_id"),
  CONSTRAINT "document_translation_runs_status_values_check"
    CHECK ("status" IN ('queued', 'preparing', 'translating', 'assembling', 'validating', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "document_translation_runs_error_code_values_check"
    CHECK ("error_code" IS NULL OR "error_code" IN ('document_unresolved', 'document_changed', 'unsupported_format', 'unsupported_review_markup', 'provider_unavailable', 'translation_failed', 'format_validation_failed', 'internal')),
  CONSTRAINT "document_translation_runs_output_values_check"
    CHECK ("output" IN ('translated', 'bilingual')),
  CONSTRAINT "document_translation_runs_engine_values_check"
    CHECK ("engine" IN ('deepl', 'ai')),
  CONSTRAINT "document_translation_runs_combination_check"
    CHECK ("output" = 'translated' OR "engine" = 'ai'),
  CONSTRAINT "document_translation_runs_ai_source_lang_check"
    CHECK ("engine" <> 'ai' OR ("source_lang" IS NOT NULL AND "source_lang" <> 'auto')),
  CONSTRAINT "document_translation_runs_progress_check"
    CHECK ("total" >= 0 AND "completed" >= 0 AND "completed" <= "total"),
  CONSTRAINT "document_translation_runs_pipeline_version_check"
    CHECK ("pipeline_version" > 0)
);--> statement-breakpoint

CREATE TABLE "document_translation_units" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "unit_key" varchar(512) NOT NULL,
  "ordinal" integer NOT NULL,
  "source_text" text NOT NULL,
  "target_text" text,
  "application" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "document_translation_units_status_values_check"
    CHECK ("status" IN ('pending', 'translated', 'failed'))
);--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_entity_id_entities_id_fk"
  FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "document_translation_units"
  ADD CONSTRAINT "document_translation_units_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_units"
  ADD CONSTRAINT "document_translation_units_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_units"
  ADD CONSTRAINT "document_translation_units_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation_units"
  ADD CONSTRAINT "document_translation_units_run_workspace_organization_fk"
  FOREIGN KEY ("run_id", "workspace_id", "organization_id")
  REFERENCES "public"."document_translation_runs"("id", "workspace_id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "document_translation_runs_document_created_idx"
  ON "document_translation_runs" ("workspace_id", "entity_id", "file_field_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "document_translation_runs_active_document_uidx"
  ON "document_translation_runs" ("workspace_id", "entity_id", "file_field_id")
  WHERE "status" IN ('queued', 'preparing', 'translating', 'assembling', 'validating');--> statement-breakpoint
CREATE UNIQUE INDEX "document_translation_units_run_key_uidx"
  ON "document_translation_units" ("run_id", "unit_key");--> statement-breakpoint
CREATE INDEX "document_translation_units_run_ordinal_idx"
  ON "document_translation_units" ("run_id", "ordinal");--> statement-breakpoint

ALTER TABLE "document_translation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_translation_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_translation_runs" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_translation_units" TO stella;--> statement-breakpoint

CREATE POLICY "document_translation_runs_workspace_select" ON "document_translation_runs" AS PERMISSIVE FOR SELECT TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_runs_workspace_insert" ON "document_translation_runs" AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_runs_workspace_update" ON "document_translation_runs" AS PERMISSIVE FOR UPDATE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_runs_workspace_delete" ON "document_translation_runs" AS PERMISSIVE FOR DELETE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "document_translation_units_workspace_select" ON "document_translation_units" AS PERMISSIVE FOR SELECT TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_units_workspace_insert" ON "document_translation_units" AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_units_workspace_update" ON "document_translation_units" AS PERMISSIVE FOR UPDATE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "document_translation_units_workspace_delete" ON "document_translation_units" AS PERMISSIVE FOR DELETE TO stella USING ((CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw) END) AND organization_id = (SELECT current_setting('app.organization_id', true)));
