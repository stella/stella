-- RLS runtime role. The connection user (`postgres` locally per
-- docker-compose.yml; the provider's master role on managed DBs)
-- runs `SET LOCAL ROLE stella` per transaction. Privileges live in
-- migration `20260510140000_document_rls_role_bootstrap`. This file is the
-- fast path for local containers only; managed providers have no init.sql,
-- so the migration entrypoint (`apps/api/src/db/migrate.ts`) bootstraps this
-- role idempotently. Keep the two in parity.
CREATE ROLE stella NOLOGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
