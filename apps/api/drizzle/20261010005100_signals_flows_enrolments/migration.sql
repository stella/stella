-- requires: 20261005120500_feature_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaced in the same statement with the expanded self-serve feature set.
ALTER TABLE "feature_enrolments"
  DROP CONSTRAINT "feature_enrolments_feature_id_check",
  ADD CONSTRAINT "feature_enrolments_feature_id_check" CHECK (feature_id IN ('time-billing', 'signals', 'flows')) NOT VALID;

--> statement-breakpoint
CREATE TABLE "pending_scout_emissions" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "last_error" varchar(128),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "pending_scout_emissions_identity_pk" PRIMARY KEY ("organization_id", "source_kind", "source_id"),
  CONSTRAINT "pending_scout_emissions_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "pending_scout_emissions_source_kind_check" CHECK (source_kind IN ('document-review', 'infosoud-hearing'))
);
--> statement-breakpoint
CREATE INDEX "pending_scout_emissions_next_attempt_idx" ON "pending_scout_emissions" ("next_attempt_at");
--> statement-breakpoint
CREATE TABLE "flow_upload_trigger_intents" (
  "definition_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "file_extension" text,
  "retry_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "flow_upload_trigger_intents_definition_id_entity_id_pk" PRIMARY KEY ("definition_id", "entity_id"),
  CONSTRAINT "flow_upload_trigger_intents_definition_org_fk" FOREIGN KEY ("definition_id", "organization_id") REFERENCES "flow_definitions"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "flow_upload_trigger_intents_entity_ws_fk" FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "flow_upload_trigger_intents_workspace_org_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "flow_upload_trigger_intents_ws_idx" ON "flow_upload_trigger_intents" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "flow_upload_trigger_intents_retry_idx" ON "flow_upload_trigger_intents" ("retry_at", "definition_id", "entity_id");
--> statement-breakpoint
ALTER TABLE "pending_scout_emissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pending_scout_emissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pending_scout_emissions" TO "stella";
--> statement-breakpoint
CREATE POLICY "pending_scout_emissions_scope_select" ON "pending_scout_emissions" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "pending_scout_emissions_scope_insert" ON "pending_scout_emissions" FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "pending_scout_emissions_scope_update" ON "pending_scout_emissions" FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "pending_scout_emissions_scope_delete" ON "pending_scout_emissions" FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "flow_upload_trigger_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_upload_trigger_intents" TO "stella";
--> statement-breakpoint
CREATE POLICY "flow_upload_trigger_intents_scope_select" ON "flow_upload_trigger_intents" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "flow_upload_trigger_intents_scope_insert" ON "flow_upload_trigger_intents" FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "flow_upload_trigger_intents_scope_update" ON "flow_upload_trigger_intents" FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
--> statement-breakpoint
CREATE POLICY "flow_upload_trigger_intents_scope_delete" ON "flow_upload_trigger_intents" FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND
    (workspace_id IS NULL OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END));
