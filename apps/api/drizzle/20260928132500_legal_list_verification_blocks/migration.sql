SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "legal_list_verification_blocks" (
  "run_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "ordinal" smallint NOT NULL,
  "block_id" text NOT NULL,
  "kind" text NOT NULL,
  "page_number" integer,
  "text" text NOT NULL,
  CONSTRAINT "legal_list_verification_blocks_pkey" PRIMARY KEY ("run_id", "ordinal"),
  CONSTRAINT "legal_list_verification_blocks_run_fk" FOREIGN KEY ("run_id", "workspace_id") REFERENCES "legal_list_verification_runs"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_verification_blocks_ordinal_check" CHECK ("ordinal" >= 0 AND "ordinal" < 32767),
  CONSTRAINT "legal_list_verification_blocks_kind_check" CHECK ("kind" IN ('docx-block', 'pdf-page')),
  CONSTRAINT "legal_list_verification_blocks_page_check" CHECK (("kind" = 'docx-block' AND "page_number" IS NULL) OR ("kind" = 'pdf-page' AND "page_number" > 0))
);--> statement-breakpoint
CREATE INDEX "legal_list_verification_blocks_run_idx" ON "legal_list_verification_blocks" ("workspace_id", "run_id", "ordinal");--> statement-breakpoint

ALTER TABLE "legal_list_verification_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_verification_blocks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_list_verification_blocks" TO "stella";--> statement-breakpoint
CREATE POLICY "workspace_select" ON "legal_list_verification_blocks" AS PERMISSIVE FOR SELECT TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legal_list_verification_blocks" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "legal_list_verification_blocks" AS PERMISSIVE FOR UPDATE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "legal_list_verification_blocks" AS PERMISSIVE FOR DELETE TO stella
  USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END));
