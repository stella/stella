-- Table/sequence grants for the `stella` RLS runtime role. RLS
-- predicates evaluate after privilege checks, so without these the
-- per-tenant policies never fire. Grants are intentionally limited to
-- RLS-enabled tables because `public` also contains Better Auth secret
-- tables; future migrations that add RLS tables must grant privileges
-- in that migration instead of relying on blanket default privileges.
--
-- The guarded revokes remove legacy bootstrap memberships from
-- docker/postgres/init.sql. Those built-in roles grant database-wide
-- read/write access, which bypasses the least-privilege boundary this
-- migration establishes. If an upgraded environment still has those
-- memberships but the migration role cannot revoke them, fail fast:
-- leaving `stella` over-privileged is not a safe partial success.
--
-- Better Auth owns login/session/OAuth state and normally runs before
-- scoped app handlers switch to `stella`. Metadata needed by scoped
-- handlers gets narrow RLS policies below; token/secret tables get
-- explicit deny policies so table grants cannot expose them.
--
-- Case-law source data is global, not tenant-owned. It still receives
-- an explicit RLS policy so `stella` access is codified table-by-table
-- instead of inherited from blanket public-schema grants.
--
-- The guarded membership grant lets the migration's connection role
-- run `SET LOCAL ROLE stella` at runtime; assumes one DATABASE_URL is
-- shared by migrations and the app. It skips CI/local setups that
-- already connect as `stella` and skips roles that already have
-- membership. If `stella` was created with provider-managed ownership
-- (e.g. via a managed DB dashboard), grant it to the migration role
-- there once before running this.

GRANT USAGE ON SCHEMA public TO stella;

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jwks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_refresh_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_access_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_consent" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_user_select" ON "user" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  id = (SELECT current_setting('app.user_id', true))
  OR EXISTS (
    SELECT 1
    FROM member m
    WHERE m.user_id = "user".id
      AND m.organization_id = (SELECT current_setting('app.organization_id', true))
  )
));
CREATE POLICY "auth_organization_select" ON "organization" AS PERMISSIVE FOR SELECT TO "stella" USING (id = (SELECT current_setting('app.organization_id', true)));
CREATE POLICY "auth_member_select" ON "member" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
CREATE POLICY "auth_member_update_last_active_workspace" ON "member" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));

CREATE POLICY "auth_no_stella_access" ON "session" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "account" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "verification" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "invitation" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "jwks" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "oauth_client" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "oauth_refresh_token" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "oauth_access_token" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);
CREATE POLICY "auth_no_stella_access" ON "oauth_consent" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);

ALTER TABLE "case_law_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_citations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_polarity_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_court_weights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_fts_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_search_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_ingestion_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case_law_ingestion_failures" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "case_law_global_access" ON "case_law_sources" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_decisions" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_citations" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_polarity_rules" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_court_weights" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_fts_configs" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_search_documents" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_ingestion_events" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);
CREATE POLICY "case_law_global_access" ON "case_law_ingestion_failures" AS PERMISSIVE FOR ALL TO "stella" USING (true) WITH CHECK (true);

DO $$
DECLARE
  target_table regclass;
BEGIN
  FOR target_table IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO stella',
      target_table
    );
  END LOOP;
END $$;

DO $$
DECLARE
  target_sequence regclass;
BEGIN
  FOR target_sequence IN
    SELECT DISTINCT seq.oid::regclass
    FROM pg_class seq
    JOIN pg_namespace n ON n.oid = seq.relnamespace
    JOIN pg_depend dep ON dep.objid = seq.oid
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
    WHERE n.nspname = 'public'
      AND tbl_ns.nspname = 'public'
      AND seq.relkind = 'S'
      AND dep.deptype IN ('a', 'i')
      AND tbl.relrowsecurity
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO stella', target_sequence);
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON TABLE
  "user",
  "organization",
  "member",
  "session",
  "account",
  "verification",
  "invitation",
  "jwks",
  "oauth_client",
  "oauth_refresh_token",
  "oauth_access_token",
  "oauth_consent"
FROM stella;

GRANT SELECT (id, name, email, image) ON TABLE "user" TO stella;
GRANT SELECT ON TABLE "organization" TO stella;
GRANT SELECT ON TABLE "member" TO stella;
GRANT UPDATE (last_active_workspace_id) ON TABLE "member" TO stella;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members am
    JOIN pg_roles role ON role.oid = am.roleid
    JOIN pg_roles member ON member.oid = am.member
    WHERE role.rolname = 'pg_read_all_data'
      AND member.rolname = 'stella'
  ) THEN
    REVOKE pg_read_all_data FROM stella;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members am
    JOIN pg_roles role ON role.oid = am.roleid
    JOIN pg_roles member ON member.oid = am.member
    WHERE role.rolname = 'pg_write_all_data'
      AND member.rolname = 'stella'
  ) THEN
    REVOKE pg_write_all_data FROM stella;
  END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM stella;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM stella;

DO $$
BEGIN
  IF CURRENT_USER <> 'stella' AND NOT pg_has_role(CURRENT_USER, 'stella', 'member') THEN
    EXECUTE format('GRANT stella TO %I', CURRENT_USER);
  END IF;
END $$;
