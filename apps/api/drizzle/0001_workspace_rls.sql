-- 0001_workspace_rls.sql
-- Enable PostgreSQL Row-Level Security for all workspace-scoped tables.
-- The application sets `app.workspace_ids` (comma-separated) per session
-- so queries are transparently scoped to the caller's workspaces.

-- ============================================================
-- 1. Create the stella_app role
-- ============================================================

-- The role is created with NOLOGIN by default.
-- Set a password before use:
--   ALTER ROLE stella_app LOGIN PASSWORD '<secret>';
-- Or provision credentials via your secrets manager.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stella_app') THEN
    CREATE ROLE stella_app NOLOGIN;
  END IF;
END $$;

-- ============================================================
-- 2. Grant privileges to stella_app
-- ============================================================

GRANT USAGE ON SCHEMA public TO stella_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stella_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stella_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stella_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stella_app;

-- ============================================================
-- 3. Enable RLS on workspace-scoped tables
-- ============================================================

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE views ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_law_matter_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Create RLS policies
-- ============================================================

-- Helper: reusable expression for workspace membership check
-- (repeated in each policy because PG doesn't support policy macros)
--   id-based:         id = ANY(string_to_array(...))
--   workspace_id-based: workspace_id = ANY(string_to_array(...))

-- ---- workspaces ----
-- SELECT/UPDATE/DELETE: only rows whose id is in the session's workspace list
-- INSERT: unrestricted (new workspace creation is controlled by app logic)
CREATE POLICY ws_select ON workspaces FOR SELECT TO stella_app
  USING (id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON workspaces FOR INSERT TO stella_app
  WITH CHECK (true);
CREATE POLICY ws_update ON workspaces FOR UPDATE TO stella_app
  USING (id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON workspaces FOR DELETE TO stella_app
  USING (id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

-- ---- workspace-scoped tables ----
-- For each: SELECT/UPDATE/DELETE filter by workspace_id;
-- INSERT checks workspace_id matches session list.

CREATE POLICY ws_select ON files FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON files FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON files FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON files FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON workspace_contacts FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON workspace_contacts FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON workspace_contacts FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON workspace_contacts FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON properties FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON properties FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON properties FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON properties FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON entities FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON entities FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON entities FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON entities FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON search_documents FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON search_documents FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON search_documents FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON search_documents FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON views FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON views FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON views FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON views FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON time_entries FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON time_entries FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON time_entries FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON time_entries FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON billing_codes FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON billing_codes FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON billing_codes FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON billing_codes FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON rate_tables FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON rate_tables FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON rate_tables FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON rate_tables FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON expenses FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON expenses FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON expenses FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON expenses FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON invoices FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON invoices FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON invoices FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON invoices FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON document_counters FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON document_counters FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON document_counters FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON document_counters FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON case_law_matter_links FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON case_law_matter_links FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON case_law_matter_links FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON case_law_matter_links FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

CREATE POLICY ws_select ON workspace_members FOR SELECT TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_insert ON workspace_members FOR INSERT TO stella_app
  WITH CHECK (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_update ON workspace_members FOR UPDATE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));
CREATE POLICY ws_delete ON workspace_members FOR DELETE TO stella_app
  USING (workspace_id = ANY(string_to_array(current_setting('app.workspace_ids', true), ',')));

-- ============================================================
-- 5. Backfill workspace_members
-- ============================================================

-- NOTE: This produces N×M rows (members × active workspaces per
-- org). For mid-size firms this is small; for large tenants
-- (1000+ members, 500+ workspaces) this may need a maintenance
-- window. ON CONFLICT DO NOTHING makes it safe to re-run.
INSERT INTO workspace_members (id, workspace_id, user_id, created_at)
SELECT
  replace(replace(substr(encode(gen_random_bytes(16), 'base64'), 1, 21), '+', '_'), '/', '-'),
  w.id,
  m.user_id,
  NOW()
FROM member m
JOIN workspaces w ON w.organization_id = m.organization_id
WHERE w.status = 'active'
ON CONFLICT DO NOTHING;
