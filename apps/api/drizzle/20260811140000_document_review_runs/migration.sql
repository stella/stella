SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A document review becomes a durable record rather than the tail of one HTTP
-- call. A run pins what was reviewed (one document version) and what it was
-- reviewed against (a playbook snapshot and/or reference document versions),
-- both by value: there is no foreign key from a run to a playbook or to the
-- reviewed documents, so deleting either leaves the run's meaning intact.
CREATE TABLE "document_review_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "content_sha256" varchar(64) NOT NULL,
  "basis" jsonb NOT NULL,
  "topics" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "error_code" varchar(64),
  "total" integer DEFAULT 0 NOT NULL,
  "completed" integer DEFAULT 0 NOT NULL,
  "requested_by" text,
  "pipeline_version" integer DEFAULT 1 NOT NULL,
  "model_ref" varchar(256),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  CONSTRAINT "document_review_runs_status_values_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "document_review_runs_error_code_values_check"
    CHECK ("error_code" IS NULL OR "error_code" IN (
      'pin_unresolved', 'pin_content_changed', 'unsupported_format',
      'ai_unavailable', 'playbook_check_failed', 'reference_check_failed',
      'enqueue_failed', 'internal'
    )),
  CONSTRAINT "document_review_runs_basis_type_check"
    CHECK ("basis"->>'type' IN ('playbook', 'references', 'combined')),
  CONSTRAINT "document_review_runs_progress_nonnegative_check"
    CHECK ("total" >= 0 AND "completed" >= 0),
  CONSTRAINT "document_review_runs_completed_within_total_check"
    CHECK ("completed" <= "total"),
  CONSTRAINT "document_review_runs_content_hash_check"
    CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_review_runs_pipeline_version_check"
    CHECK ("pipeline_version" > 0)
);--> statement-breakpoint

-- One judgment per confirmed topic per check kind. The unique key below is the
-- upsert key, so a re-delivered job converges onto the rows it already wrote.
CREATE TABLE "document_review_findings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_field_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "topic_id" uuid NOT NULL,
  "topic_title" varchar(256) NOT NULL,
  "check_kind" text NOT NULL,
  "position_id" uuid,
  "outcome" varchar(64),
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "document_review_findings_check_kind_values_check"
    CHECK ("check_kind" IN ('playbook', 'reference')),
  -- The two outcome vocabularies stay separate: verdict tiers grade a playbook
  -- position, the comparison vocabulary describes a reference difference. Only
  -- a playbook-kind row names a position, and only it may omit an outcome (an
  -- extract-only position yields a value with no verdict).
  CONSTRAINT "document_review_findings_outcome_check" CHECK (
    (
      "check_kind" = 'playbook'
      AND (
        "outcome" IS NULL
        OR "outcome" IN (
          'compliant', 'fallback', 'deviation', 'missing', 'not-applicable'
        )
      )
    ) OR (
      "check_kind" = 'reference'
      AND "outcome" IN (
        'aligned', 'different', 'missing-from-target',
        'additional-in-target', 'deal-specific', 'not-comparable'
      )
      AND "position_id" IS NULL
    )
  )
);--> statement-breakpoint

ALTER TABLE "document_review_runs"
  ADD CONSTRAINT "document_review_runs_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_runs"
  ADD CONSTRAINT "document_review_runs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_runs"
  ADD CONSTRAINT "document_review_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_run_id_document_review_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."document_review_runs"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- History read: the newest runs for one document, keyset-paginated.
CREATE INDEX "document_review_runs_document_created_idx"
  ON "document_review_runs" (
    "workspace_id", "entity_id", "file_field_id", "created_at" DESC, "id" DESC
  );--> statement-breakpoint

-- At most one unfinished run per document. The create endpoint answers 409
-- before reaching here; this index is what makes a lost race impossible rather
-- than unlikely.
CREATE UNIQUE INDEX "document_review_runs_active_document_uidx"
  ON "document_review_runs" ("workspace_id", "entity_id", "file_field_id")
  WHERE "status" IN ('queued', 'running');--> statement-breakpoint

CREATE UNIQUE INDEX "document_review_findings_run_topic_kind_uidx"
  ON "document_review_findings" ("run_id", "topic_id", "check_kind");--> statement-breakpoint

CREATE INDEX "document_review_findings_document_idx"
  ON "document_review_findings" ("workspace_id", "entity_id", "file_field_id");--> statement-breakpoint

ALTER TABLE "document_review_runs"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_review_findings"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_review_runs" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_review_findings" TO stella;--> statement-breakpoint

-- Both scopes in every command. These tables persist an organization
-- discriminator alongside the workspace, so requiring only the workspace pin
-- would let a row whose organization_id came from elsewhere be reached through
-- a legitimate workspace authorization.
CREATE POLICY "document_review_runs_workspace_select"
  ON "document_review_runs" AS PERMISSIVE FOR SELECT TO stella
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
CREATE POLICY "document_review_runs_workspace_insert"
  ON "document_review_runs" AS PERMISSIVE FOR INSERT TO stella
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
CREATE POLICY "document_review_runs_workspace_update"
  ON "document_review_runs" AS PERMISSIVE FOR UPDATE TO stella
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
CREATE POLICY "document_review_runs_workspace_delete"
  ON "document_review_runs" AS PERMISSIVE FOR DELETE TO stella
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

CREATE POLICY "document_review_findings_workspace_select"
  ON "document_review_findings" AS PERMISSIVE FOR SELECT TO stella
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
CREATE POLICY "document_review_findings_workspace_insert"
  ON "document_review_findings" AS PERMISSIVE FOR INSERT TO stella
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
CREATE POLICY "document_review_findings_workspace_update"
  ON "document_review_findings" AS PERMISSIVE FOR UPDATE TO stella
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
CREATE POLICY "document_review_findings_workspace_delete"
  ON "document_review_findings" AS PERMISSIVE FOR DELETE TO stella
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
