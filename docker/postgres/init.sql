-- RLS runtime role. The application's connection user (locally
-- `postgres` per docker-compose.yml; on managed deployments a
-- master user the provider creates) runs `SET LOCAL ROLE stella`
-- per transaction to activate per-tenant policies. Role creation
-- lives here so local docker-compose works on a fresh DB; the
-- canonical source for stella's table and sequence privileges is
-- the migration
-- `apps/api/drizzle/20260510140000_document_rls_role_bootstrap`,
-- which runs on every environment via the standard migration path.
-- On managed providers (RDS, Neon, etc.), create the role once via
-- the provider's CLI or dashboard before running migrations.
CREATE ROLE stella NOLOGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
