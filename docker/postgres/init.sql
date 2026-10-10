-- The image entrypoint connects as the owner; the readiness helper may use
-- the socket-only bootstrap login to repair an existing owner's RLS bypass.
\if :{?owner}
\else
\set owner :USER
\endif

-- initdb's original role (OID 10) cannot lose SUPERUSER. Replace the
-- application login atomically, retaining its password and user objects.
SELECT oid = 10 AS initdb_owner FROM pg_roles WHERE rolname = :'owner'
\gset
\if :initdb_owner
BEGIN;
-- Avoid logging the copied password verifier. Restore DDL logging immediately.
SELECT current_setting('log_statement') AS previous_log_statement
\gset
SET LOCAL log_statement = 'none';
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB PASSWORD %L', :'owner', rolpassword) AS create_owner
FROM pg_authid WHERE rolname = :'owner'
\gset
-- A temporary NOLOGIN role allows renaming the original session user.
CREATE ROLE stella_setup NOLOGIN SUPERUSER;
SET SESSION AUTHORIZATION stella_setup;
-- Earlier failed initialization may have created this passwordless role.
DROP ROLE IF EXISTS stella_bootstrap;
SELECT format('ALTER ROLE %I RENAME TO stella_bootstrap', :'owner')
\gexec
:create_owner;
SELECT set_config('log_statement', :'previous_log_statement', true);
ALTER ROLE stella_bootstrap PASSWORD NULL;
SET SESSION AUTHORIZATION stella_bootstrap;
DROP ROLE stella_setup;
-- Retain existing application-role memberships with their exact options.
SELECT format('GRANT %I TO %I WITH ADMIN %s, INHERIT %s, SET %s',
  role.rolname, :'owner', CASE WHEN membership.admin_option THEN 'TRUE' ELSE 'FALSE' END,
  CASE WHEN membership.inherit_option THEN 'TRUE' ELSE 'FALSE' END,
  CASE WHEN membership.set_option THEN 'TRUE' ELSE 'FALSE' END)
FROM pg_auth_members membership JOIN pg_roles role ON role.oid = membership.roleid
WHERE membership.member = 10 AND role.rolname LIKE 'stella%' AND NOT role.rolsuper
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'owner')
\gexec
-- REASSIGN OWNED cannot transfer initdb's pinned system objects. Transfer
-- only application schemas and objects; preserve extension ownership.
SELECT format('ALTER SCHEMA %I OWNER TO %I', nspname, :'owner')
FROM pg_namespace WHERE nspname IN ('public', 'drizzle') AND nspowner = 10
\gexec
SELECT format('ALTER %s %I.%I OWNER TO %I',
  CASE relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
  nspname, relname, :'owner')
FROM pg_class JOIN pg_namespace ON pg_namespace.oid = relnamespace
WHERE nspname IN ('public', 'drizzle') AND relowner = 10
  AND relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_class'::regclass AND objid = pg_class.oid AND deptype = 'e')
ORDER BY CASE WHEN relkind = 'S' THEN 1 ELSE 0 END
\gexec
SELECT format('ALTER ROUTINE %s OWNER TO %I', pg_proc.oid::regprocedure, :'owner')
FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pronamespace
WHERE nspname IN ('public', 'drizzle') AND proowner = 10
  AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_proc'::regclass AND objid = pg_proc.oid AND deptype = 'e')
\gexec
SELECT format('ALTER TYPE %I.%I OWNER TO %I', nspname, typname, :'owner')
FROM pg_type JOIN pg_namespace ON pg_namespace.oid = typnamespace
WHERE nspname IN ('public', 'drizzle') AND typowner = 10 AND typtype IN ('e', 'd')
  AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_type'::regclass AND objid = pg_type.oid AND deptype = 'e')
\gexec
COMMIT;
\else
SELECT 'CREATE ROLE stella_bootstrap LOGIN SUPERUSER'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_bootstrap')
\gexec
\endif

-- Passwordless maintenance is available only through the container socket;
-- the application owner has no membership in the bootstrap role.
SELECT 'CREATE ROLE stella NOLOGIN NOSUPERUSER NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella')
\gexec
SELECT format('GRANT stella TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', :'owner')
\gexec
-- Read protected settings for parity checks and other sessions' statistics
-- for the migration load gate, without pg_monitor's table-scanning functions.
SELECT format('GRANT pg_read_all_settings, pg_read_all_stats TO %I', :'owner')
\gexec
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB', :'owner')
\gexec
