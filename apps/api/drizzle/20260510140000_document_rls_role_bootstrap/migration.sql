-- Table/sequence grants for the `stella` RLS runtime role. RLS
-- predicates evaluate after privilege checks, so without these the
-- per-tenant policies never fire. ALTER DEFAULT PRIVILEGES covers
-- tables created by future migrations.
--
-- The trailing `GRANT stella TO CURRENT_USER` lets the migration's
-- connection role run `SET LOCAL ROLE stella` at runtime; assumes
-- one DATABASE_URL is shared by migrations and the app. If `stella`
-- was created with provider-managed ownership (e.g. via a managed
-- DB dashboard), grant it to the migration role there once before
-- running this. Idempotent.

GRANT USAGE ON SCHEMA public TO stella;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stella;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stella;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stella;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stella;

GRANT stella TO CURRENT_USER;
