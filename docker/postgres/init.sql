-- RLS runtime role. The app connects as postgres and uses
-- SET LOCAL ROLE stella per transaction to activate policies.
-- On managed providers (PlanetScale, Neon), create this role
-- via their CLI/dashboard instead.
CREATE ROLE stella NOLOGIN;
GRANT USAGE ON SCHEMA public TO stella;
GRANT pg_read_all_data TO stella;
GRANT pg_write_all_data TO stella;

CREATE EXTENSION IF NOT EXISTS unaccent;
