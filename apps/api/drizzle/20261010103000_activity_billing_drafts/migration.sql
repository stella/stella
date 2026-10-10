SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE organization_settings ADD COLUMN ai_billing_drafts_mode text NOT NULL DEFAULT 'disabled';--> statement-breakpoint
ALTER TABLE organization_settings ADD CONSTRAINT organization_settings_ai_billing_drafts_mode_check CHECK (ai_billing_drafts_mode IN ('disabled', 'enabled'));--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN time_billing_format text NOT NULL DEFAULT 'categories';--> statement-breakpoint
ALTER TABLE contacts ADD CONSTRAINT contacts_time_billing_format_check CHECK (time_billing_format IN ('categories', 'ledes'));--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN billing_narrative_language varchar(64);--> statement-breakpoint
CREATE TABLE billing_draft_user_settings (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  consent_at timestamptz,
  preference varchar(2000),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE billing_guideline_files (
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES agent_skill_resources(id) ON DELETE CASCADE,
  client_id uuid REFERENCES contacts(id) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX billing_guideline_files_firm_uidx ON billing_guideline_files(organization_id) WHERE client_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX billing_guideline_files_client_resource_uidx ON billing_guideline_files(organization_id, client_id, resource_id) WHERE client_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX billing_guideline_files_org_client_idx ON billing_guideline_files(organization_id, client_id);--> statement-breakpoint
ALTER TABLE billing_draft_user_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_select" ON billing_draft_user_settings FOR SELECT TO stella USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON billing_draft_user_settings FOR INSERT TO stella WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON billing_draft_user_settings FOR UPDATE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON billing_draft_user_settings FOR DELETE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_draft_user_settings TO stella;--> statement-breakpoint
ALTER TABLE billing_guideline_files ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_select" ON billing_guideline_files FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "admin_insert" ON billing_guideline_files FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin')));--> statement-breakpoint
CREATE POLICY "admin_update" ON billing_guideline_files FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin'))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)) AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin')));--> statement-breakpoint
CREATE POLICY "admin_delete" ON billing_guideline_files FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)) AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = (SELECT current_setting('app.organization_id', true)) AND m.user_id = (SELECT current_setting('app.user_id', true)) AND m.role IN ('owner', 'admin')));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_guideline_files TO stella;--> statement-breakpoint
ALTER TABLE billing_draft_user_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_guideline_files FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX agent_skill_resources_path_billing_trgm_idx ON agent_skill_resources USING gin (path gin_trgm_ops);--> statement-breakpoint
