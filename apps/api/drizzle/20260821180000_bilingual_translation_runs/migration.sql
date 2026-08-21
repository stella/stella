SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A bilingual translation becomes a durable record: the run pins the document
-- version it was prepared against and snapshots the glossary the reviewer
-- confirmed. No foreign key to the document: a deleted document must not take
-- its run history with it.
CREATE TABLE "bilingual_translation_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "source_lang" varchar(16) NOT NULL,
  "target_lang" varchar(16) NOT NULL,
  "glossary" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error_code" varchar(64),
  "total" integer DEFAULT 0 NOT NULL,
  "completed" integer DEFAULT 0 NOT NULL,
  "output_entity_version_id" uuid,
  "requested_by" text,
  "model_ref" varchar(256),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "bilingual_translation_runs_status_values_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "bilingual_translation_runs_error_code_values_check"
    CHECK ("error_code" IS NULL OR "error_code" IN (
      'document_unresolved', 'document_changed', 'not_bilingual',
      'ai_unavailable', 'translation_failed', 'apply_failed',
      'enqueue_failed', 'internal'
    )),
  CONSTRAINT "bilingual_translation_runs_progress_check"
    CHECK ("total" >= 0 AND "completed" >= 0 AND "completed" <= "total")
);--> statement-breakpoint

-- One row of the bilingual table per run: the confirmed disposition and the
-- translation once produced. (run_id, row_id) is the upsert key, so a
-- re-delivered batch converges onto the rows it already wrote.
CREATE TABLE "bilingual_translation_rows" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "row_id" varchar(64) NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" text NOT NULL,
  "in_table" boolean DEFAULT false NOT NULL,
  "disposition" text NOT NULL,
  "disposition_origin" text NOT NULL,
  "source_para_id" varchar(64),
  "source_text" text NOT NULL,
  "target_text" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "bilingual_translation_rows_kind_values_check"
    CHECK ("kind" IN ('paragraph', 'heading', 'listItem', 'table')),
  CONSTRAINT "bilingual_translation_rows_disposition_values_check"
    CHECK ("disposition" IN ('translate', 'keep', 'inline')),
  CONSTRAINT "bilingual_translation_rows_origin_values_check"
    CHECK ("disposition_origin" IN ('rule', 'model', 'default', 'user')),
  CONSTRAINT "bilingual_translation_rows_status_values_check"
    CHECK ("status" IN ('pending', 'translated', 'failed'))
);--> statement-breakpoint

ALTER TABLE "bilingual_translation_runs"
  ADD CONSTRAINT "bilingual_translation_runs_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_runs"
  ADD CONSTRAINT "bilingual_translation_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_runs"
  ADD CONSTRAINT "bilingual_translation_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_runs"
  ADD CONSTRAINT "bilingual_translation_runs_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "bilingual_translation_rows"
  ADD CONSTRAINT "bilingual_translation_rows_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_rows"
  ADD CONSTRAINT "bilingual_translation_rows_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_rows"
  ADD CONSTRAINT "bilingual_translation_rows_run_id_bilingual_translation_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."bilingual_translation_runs"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bilingual_translation_rows"
  ADD CONSTRAINT "bilingual_translation_rows_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "bilingual_translation_runs_document_created_idx"
  ON "bilingual_translation_runs" (
    "workspace_id", "entity_id", "file_field_id", "created_at" DESC, "id" DESC
  );--> statement-breakpoint

-- At most one unfinished run per document.
CREATE UNIQUE INDEX "bilingual_translation_runs_active_document_uidx"
  ON "bilingual_translation_runs" ("workspace_id", "entity_id", "file_field_id")
  WHERE "status" IN ('queued', 'running');--> statement-breakpoint

CREATE UNIQUE INDEX "bilingual_translation_rows_run_row_uidx"
  ON "bilingual_translation_rows" ("run_id", "row_id");--> statement-breakpoint
CREATE INDEX "bilingual_translation_rows_run_ordinal_idx"
  ON "bilingual_translation_rows" ("run_id", "ordinal");--> statement-breakpoint

ALTER TABLE "bilingual_translation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bilingual_translation_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs; both are needed.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bilingual_translation_runs" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bilingual_translation_rows" TO stella;--> statement-breakpoint

-- Both scopes in every command: the rows carry an organization discriminator
-- next to the workspace, so a workspace pin alone must not reach a row whose
-- organization_id came from elsewhere.
CREATE POLICY "bilingual_translation_runs_workspace_select"
  ON "bilingual_translation_runs" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_runs_workspace_insert"
  ON "bilingual_translation_runs" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_runs_workspace_update"
  ON "bilingual_translation_runs" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_runs_workspace_delete"
  ON "bilingual_translation_runs" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint

CREATE POLICY "bilingual_translation_rows_workspace_select"
  ON "bilingual_translation_rows" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_rows_workspace_insert"
  ON "bilingual_translation_rows" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_rows_workspace_update"
  ON "bilingual_translation_rows" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "bilingual_translation_rows_workspace_delete"
  ON "bilingual_translation_rows" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
