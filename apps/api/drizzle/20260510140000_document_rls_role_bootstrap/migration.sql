-- Stella enforces tenant isolation via Postgres Row-Level Security.
-- The application's connection user runs `SET LOCAL ROLE stella` per
-- transaction; policies on every table (see
-- `CREATE POLICY ... TO "stella"` in earlier migrations) restrict the
-- rows `stella` can read or write to those matching the
-- workspace_ids / organization_id GUCs set for the current
-- transaction.
--
-- The table and sequence GRANTs are the privilege layer RLS sits on
-- top of: PostgreSQL evaluates table privileges before RLS
-- predicates, so policies only apply to rows `stella` is allowed to
-- touch in the first place. Mirrors the test bootstrap in
-- `apps/api/src/tests/security/test-utils.ts`.
--
-- The `ALTER DEFAULT PRIVILEGES` statements ensure the same grants
-- apply automatically to tables and sequences created by future
-- migrations, so this file stays the canonical source for `stella`'s
-- privileges and does not need to be updated as the schema grows.
--
-- The final `GRANT stella TO CURRENT_USER` makes `SET LOCAL ROLE
-- stella` work for non-superuser connection roles. It grants
-- membership to whichever role runs the migration; this is
-- intentional today because Stella's setup uses a single
-- DATABASE_URL for both `bun run db:migrate` and runtime, so the
-- migration role and the application connection role are the same.
--
-- Caveats worth knowing if you operate this:
--   - No-op for superuser connections (local docker `postgres`,
--     RDS master via `rds_superuser`); they can `SET ROLE`
--     regardless of explicit membership.
--   - If you ever split the migration and runtime roles, this
--     grant will target the migration role; you must also issue
--     `GRANT stella TO <runtime_role>` separately so the app can
--     activate the role at request time.
--   - On managed providers where `stella` was created out of band
--     by the provider's dashboard with provider-managed ownership,
--     the migration role may lack admin rights on `stella` and
--     this statement will fail with `permission denied`. In that
--     case run `GRANT stella TO <migration_role>` once via the
--     same dashboard before running migrations.
--
-- Idempotent: re-granting an existing privilege is a no-op in
-- Postgres, so this migration applies cleanly to environments where
-- the role was already bootstrapped out of band.

GRANT USAGE ON SCHEMA public TO stella;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stella;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stella;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stella;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stella;

GRANT stella TO CURRENT_USER;
