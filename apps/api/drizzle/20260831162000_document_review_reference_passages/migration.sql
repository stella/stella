SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The words a reference-derived position quotes, one row per block of a
-- reference document version, owned by the matter that document belongs to.
-- Positions, run bases, findings and playbooks hold only the row id and its
-- provenance, so this table's row security is what decides, per reader,
-- whether another matter's clause comes back.
CREATE TABLE "document_review_reference_passages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "block_id" varchar(128) NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "document_review_reference_passages"
  ADD CONSTRAINT "document_review_reference_passages_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_reference_passages"
  ADD CONSTRAINT "document_review_reference_passages_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_reference_passages"
  ADD CONSTRAINT "document_review_reference_passages_workspace_organization_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspaces"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_reference_passages"
  ADD CONSTRAINT "document_review_reference_passages_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id")
  REFERENCES "public"."entities"("id", "workspace_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Content-addressed: a block quoted by ten positions is one row, and a
-- re-proposal against the same version reuses it.
CREATE UNIQUE INDEX "document_review_reference_passages_version_block_uidx"
  ON "document_review_reference_passages" ("entity_version_id", "block_id");--> statement-breakpoint

ALTER TABLE "document_review_reference_passages"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs; both are needed.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "document_review_reference_passages" TO stella;--> statement-breakpoint

-- Both scopes in every command: the row persists an organization
-- discriminator alongside the workspace, so requiring only the workspace pin
-- would let a row whose organization_id came from elsewhere be reached
-- through a legitimate workspace authorization.
CREATE POLICY "document_review_reference_passages_workspace_select"
  ON "document_review_reference_passages" AS PERMISSIVE FOR SELECT TO stella
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
CREATE POLICY "document_review_reference_passages_workspace_insert"
  ON "document_review_reference_passages" AS PERMISSIVE FOR INSERT TO stella
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
CREATE POLICY "document_review_reference_passages_workspace_update"
  ON "document_review_reference_passages" AS PERMISSIVE FOR UPDATE TO stella
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
CREATE POLICY "document_review_reference_passages_workspace_delete"
  ON "document_review_reference_passages" AS PERMISSIVE FOR DELETE TO stella
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
