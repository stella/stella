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
-- stella` work for non-superuser connection users on managed
-- providers; it is a no-op for superuser connections (local docker
-- `postgres`, RDS master via `rds_superuser`) but is required when
-- the migration runs as a non-superuser app role on, e.g., Neon.
-- Assumes the migration role and the application connection role
-- are the same (true for `bun run db:migrate` against `DATABASE_URL`).
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
