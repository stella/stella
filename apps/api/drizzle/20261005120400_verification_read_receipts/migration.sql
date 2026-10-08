-- requires: 20261005120300_list_verification_access_revoked
-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE TABLE "legal_list_verification_read_receipts" (
  organization_id varchar(128) NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  audited_day date NOT NULL,
  CONSTRAINT verification_read_receipts_pk PRIMARY KEY (organization_id, workspace_id, run_id, user_id),
  CONSTRAINT verification_read_receipts_run_fk FOREIGN KEY (run_id, workspace_id)
    REFERENCES legal_list_verification_runs(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT verification_read_receipts_workspace_org_fk FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX verification_read_receipts_run_idx ON legal_list_verification_read_receipts(workspace_id, run_id);--> statement-breakpoint
CREATE INDEX verification_read_receipts_user_idx ON legal_list_verification_read_receipts(user_id);--> statement-breakpoint
ALTER TABLE legal_list_verification_read_receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE legal_list_verification_read_receipts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_list_verification_read_receipts TO stella;--> statement-breakpoint
CREATE POLICY "legal_list_verification_read_receipts_user_select" ON legal_list_verification_read_receipts
  FOR SELECT TO stella USING ((user_id = (SELECT current_setting('app.user_id', true)) AND
  (CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true ELSE workspace_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
  AND organization_id = (SELECT current_setting('app.organization_id', true))));--> statement-breakpoint
CREATE POLICY "legal_list_verification_read_receipts_user_insert" ON legal_list_verification_read_receipts
  FOR INSERT TO stella WITH CHECK ((user_id = (SELECT current_setting('app.user_id', true)) AND
  (CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true ELSE workspace_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
  AND organization_id = (SELECT current_setting('app.organization_id', true))));--> statement-breakpoint
CREATE POLICY "legal_list_verification_read_receipts_user_update" ON legal_list_verification_read_receipts
  FOR UPDATE TO stella USING ((user_id = (SELECT current_setting('app.user_id', true)) AND
  (CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true ELSE workspace_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
  AND organization_id = (SELECT current_setting('app.organization_id', true))));--> statement-breakpoint
CREATE POLICY "legal_list_verification_read_receipts_user_delete" ON legal_list_verification_read_receipts
  FOR DELETE TO stella USING ((user_id = (SELECT current_setting('app.user_id', true)) AND
  (CASE WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true ELSE workspace_id IN (SELECT authorized_workspace_id FROM public.stella_authorized_workspaces) END)
  AND organization_id = (SELECT current_setting('app.organization_id', true))));--> statement-breakpoint
