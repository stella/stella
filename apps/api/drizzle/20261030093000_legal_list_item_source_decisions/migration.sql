SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

CREATE TABLE "legal_list_item_source_decisions" (
  "entity_feature_gate" text DEFAULT 'pending' NOT NULL,
  "entity_feature_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "decision" text,
  "reason" text,
  "actor_id" text,
  "created_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "legal_list_item_source_decisions_decision_check" CHECK ("decision" IN ('accepted', 'rejected')),
  CONSTRAINT "legal_list_item_source_decisions_reason_length_check" CHECK (char_length("reason") <= 2000),
  CONSTRAINT "legal_list_item_source_decisions_source_fk" FOREIGN KEY ("source_id") REFERENCES "legal_list_item_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_item_source_decisions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX "legal_list_item_source_decisions_source_created_idx" ON "legal_list_item_source_decisions" ("source_id", "created_at");--> statement-breakpoint

ALTER TABLE "legal_list_item_source_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_item_source_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "legal_list_item_source_decisions" TO stella;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "legal_list_item_source_decisions"
  AS PERMISSIVE FOR SELECT TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legal_list_item_source_decisions"
  AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END) AND EXISTS (
    SELECT 1 FROM public.legal_list_item_sources decided_source
    WHERE decided_source.id = legal_list_item_source_decisions.source_id
      AND decided_source.workspace_id = legal_list_item_source_decisions.workspace_id
  ));--> statement-breakpoint
CREATE POLICY "legal_list_item_source_decisions_owner_access" ON "legal_list_item_source_decisions"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_item_source_decisions'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_item_source_decisions'::regclass));--> statement-breakpoint
CREATE POLICY "legal_list_item_source_decisions_no_update" ON "legal_list_item_source_decisions"
  AS RESTRICTIVE FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "legal_list_item_source_decisions_no_delete" ON "legal_list_item_source_decisions"
  AS RESTRICTIVE FOR DELETE TO stella USING (false);
