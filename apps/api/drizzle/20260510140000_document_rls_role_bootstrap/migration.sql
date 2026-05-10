-- Table/sequence grants for the `stella` RLS runtime role. RLS
-- predicates evaluate after privilege checks, so without these the
-- per-tenant policies never fire. ALTER DEFAULT PRIVILEGES covers
-- tables created by future migrations.
--
-- The guarded revokes remove legacy bootstrap memberships from
-- docker/postgres/init.sql. Those built-in roles grant database-wide
-- read/write access, which bypasses the least-privilege boundary this
-- migration establishes. If an upgraded environment still has those
-- memberships but the migration role cannot revoke them, fail fast:
-- leaving `stella` over-privileged is not a safe partial success.
--
-- The guarded membership grant lets the migration's connection role
-- run `SET LOCAL ROLE stella` at runtime; assumes one DATABASE_URL is
-- shared by migrations and the app. It skips CI/local setups that
-- already connect as `stella` and skips roles that already have
-- membership. If `stella` was created with provider-managed ownership
-- (e.g. via a managed DB dashboard), grant it to the migration role
-- there once before running this.

GRANT USAGE ON SCHEMA public TO stella;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stella;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stella;

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
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stella;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stella;

DO $$
BEGIN
  IF CURRENT_USER <> 'stella' AND NOT pg_has_role(CURRENT_USER, 'stella', 'member') THEN
    EXECUTE format('GRANT stella TO %I', CURRENT_USER);
  END IF;
END $$;
