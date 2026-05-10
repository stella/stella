-- RLS runtime role. The connection user (`postgres` locally per
-- docker-compose.yml; the provider's master role on managed DBs)
-- runs `SET LOCAL ROLE stella` per transaction. Privileges live in
-- migration `20260510140000_document_rls_role_bootstrap`. On managed
-- providers, create this role via the dashboard before migrations.
CREATE ROLE stella NOLOGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
