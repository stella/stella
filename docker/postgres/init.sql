-- The image entrypoint connects as the owner; the readiness helper may use
-- the socket-only bootstrap login to repair an existing owner's RLS bypass.
\if :{?owner}
\else
\set owner :USER
\endif

-- The image entrypoint supplies the owner login and database. Keep a
-- passwordless bootstrap login for trusted Unix-socket maintenance only;
-- network authentication requires a password, which this role never has.
SELECT 'CREATE ROLE stella_bootstrap LOGIN SUPERUSER'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_bootstrap')
\gexec

SELECT 'CREATE ROLE stella NOLOGIN NOSUPERUSER NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella')
\gexec
SELECT format('GRANT stella TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', :'owner')
\gexec
SELECT format('GRANT pg_monitor TO %I', :'owner')
\gexec
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Run last: migrations and application sessions use this database owner,
-- whose privileges must not bypass FORCE ROW LEVEL SECURITY.
SELECT format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB', :'owner')
\gexec
