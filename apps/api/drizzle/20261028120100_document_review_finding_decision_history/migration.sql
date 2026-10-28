SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "document_review_finding_decisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "finding_id" uuid NOT NULL,
  "decision" text,
  "reason" text,
  "actor_id" text,
  "created_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "document_review_finding_decisions_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('accepted', 'rejected')),
  CONSTRAINT "document_review_finding_decisions_reason_length_check"
    CHECK ("reason" IS NULL OR char_length("reason") <= 2000),
  CONSTRAINT "document_review_finding_decisions_finding_id_document_review_findings_id_fk"
    FOREIGN KEY ("finding_id") REFERENCES "document_review_findings"("id") ON DELETE CASCADE,
  CONSTRAINT "document_review_finding_decisions_actor_id_user_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL
);--> statement-breakpoint

CREATE INDEX "document_review_finding_decisions_finding_created_idx"
  ON "document_review_finding_decisions" ("finding_id", "created_at");--> statement-breakpoint

ALTER TABLE "document_review_finding_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_review_finding_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "document_review_finding_decisions" TO stella;--> statement-breakpoint

CREATE POLICY "document_review_finding_decisions_workspace_select"
  ON "document_review_finding_decisions" AS PERMISSIVE FOR SELECT TO stella
  USING (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END);--> statement-breakpoint

CREATE POLICY "document_review_finding_decisions_workspace_insert"
  ON "document_review_finding_decisions" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END);--> statement-breakpoint

CREATE POLICY "document_review_finding_decisions_owner_access"
  ON "document_review_finding_decisions" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.document_review_finding_decisions'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.document_review_finding_decisions'::regclass));
