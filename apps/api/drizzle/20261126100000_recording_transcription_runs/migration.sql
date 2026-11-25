SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- Transcriptions of recordings stored in a matter (#9322): one run per
-- Transcribe request, which saves its transcript next to the recording.
CREATE TABLE "recording_transcription_runs" (
	"entity_feature_gate" text DEFAULT 'pending' NOT NULL,
	"entity_feature_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_field_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"source_file_name" varchar(1024) NOT NULL,
	"source_mime_type" varchar(256) NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" varchar(64),
	"duration_ms" integer,
	"transcribed_ms" integer DEFAULT 0 NOT NULL,
	"output_entity_id" uuid,
	"output_field_id" uuid,
	"output_file_name" varchar(1024),
	"requested_by" text,
	"model_ref" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "entity_feature_gate_states_check" CHECK ("entity_feature_gate" IN ('pending', 'open', 'legal-lists', 'missing')),
	CONSTRAINT "entity_feature_gate_ready_check" CHECK ("entity_feature_gate" <> 'pending'),
	CONSTRAINT "recording_transcription_runs_status_values_check" CHECK ("status" IN ('queued', 'transcribing', 'saving', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "recording_transcription_runs_error_code_values_check" CHECK ("error_code" IS NULL OR "error_code" IN ('document_unresolved', 'document_changed', 'unsupported_format', 'too_long', 'no_speech', 'provider_unavailable', 'transcription_failed', 'internal')),
	CONSTRAINT "recording_transcription_runs_state_fields_check" CHECK (("status" = 'completed') = ("output_entity_id" IS NOT NULL) AND ("status" = 'failed') = ("error_code" IS NOT NULL) AND ("status" IN ('completed', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL)),
	CONSTRAINT "recording_transcription_runs_progress_check" CHECK ("transcribed_ms" >= 0 AND ("duration_ms" IS NULL OR "duration_ms" >= 0))
);--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ADD CONSTRAINT "recording_transcription_runs_version_fk" FOREIGN KEY ("entity_version_id","entity_id","workspace_id") REFERENCES "entity_versions"("id","entity_id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "recording_transcription_runs_document_created_idx" ON "recording_transcription_runs" ("workspace_id","entity_id","file_field_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recording_transcription_runs_active_document_uidx" ON "recording_transcription_runs" ("workspace_id","entity_id","file_field_id") WHERE "status" IN ('queued', 'transcribing', 'saving');--> statement-breakpoint
CREATE INDEX "recording_transcription_runs_ef_entity_id_idx" ON "recording_transcription_runs" ("entity_id");--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recording_transcription_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recording_transcription_runs" TO stella;--> statement-breakpoint
CREATE POLICY "recording_transcription_runs_owner" ON "recording_transcription_runs" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.recording_transcription_runs'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.recording_transcription_runs'::regclass));--> statement-breakpoint
CREATE POLICY "workspace_entity_feature" ON "recording_transcription_runs" AS RESTRICTIVE FOR ALL TO "stella" USING (("recording_transcription_runs"."entity_feature_gate" = 'open' OR ("recording_transcription_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("recording_transcription_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "recording_transcription_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("recording_transcription_runs"."entity_feature_gate" = 'open' OR ("recording_transcription_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("recording_transcription_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "recording_transcription_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));--> statement-breakpoint
CREATE POLICY "recording_transcription_runs_workspace_select" ON "recording_transcription_runs" AS PERMISSIVE FOR SELECT TO "stella" USING ((
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
CREATE POLICY "recording_transcription_runs_workspace_insert" ON "recording_transcription_runs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
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
CREATE POLICY "recording_transcription_runs_workspace_update" ON "recording_transcription_runs" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
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
CREATE POLICY "recording_transcription_runs_workspace_delete" ON "recording_transcription_runs" AS PERMISSIVE FOR DELETE TO "stella" USING ((
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
