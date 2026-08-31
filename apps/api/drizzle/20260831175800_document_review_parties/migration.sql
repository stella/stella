SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The target document's parties, detected once per document version so the
-- review launcher can show "We act for" before any proposal pass runs. One
-- row per version: `prompt_version` invalidates a stale row rather than the
-- table accumulating history the way a run does.
CREATE TABLE "document_review_parties" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "prompt_version" smallint NOT NULL,
  "parties" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "document_review_parties"
  ADD CONSTRAINT "document_review_parties_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_parties"
  ADD CONSTRAINT "document_review_parties_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_parties"
  ADD CONSTRAINT "document_review_parties_entity_version_id_entity_versions_id_fk"
  FOREIGN KEY ("entity_version_id") REFERENCES "public"."entity_versions"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_parties"
  ADD CONSTRAINT "document_review_parties_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "public"."entities"("id", "workspace_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One current answer per document version: a re-detection overwrites this
-- row instead of adding a second one.
CREATE UNIQUE INDEX "document_review_parties_entity_version_uidx"
  ON "document_review_parties" ("entity_version_id");--> statement-breakpoint

ALTER TABLE "document_review_parties"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "document_review_parties" TO stella;--> statement-breakpoint

-- Both scopes in every command: this table persists an organization
-- discriminator alongside the workspace, so requiring only the workspace pin
-- would let a row whose organization_id came from elsewhere be reached
-- through a legitimate workspace authorization.
CREATE POLICY "document_review_parties_workspace_select"
  ON "document_review_parties" AS PERMISSIVE FOR SELECT TO stella
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
CREATE POLICY "document_review_parties_workspace_insert"
  ON "document_review_parties" AS PERMISSIVE FOR INSERT TO stella
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
CREATE POLICY "document_review_parties_workspace_update"
  ON "document_review_parties" AS PERMISSIVE FOR UPDATE TO stella
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
CREATE POLICY "document_review_parties_workspace_delete"
  ON "document_review_parties" AS PERMISSIVE FOR DELETE TO stella
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
