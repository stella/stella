-- The image entrypoint connects as the owner; the readiness helper may use
-- a socket peer session to assume the NOLOGIN bootstrap role for repairs.
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
ALTER ROLE stella_bootstrap NOLOGIN PASSWORD NULL;
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
SELECT 'CREATE ROLE stella_bootstrap NOLOGIN SUPERUSER'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_bootstrap')
\gexec
\endif

-- NOLOGIN denies direct bootstrap authentication even under host trust.
-- The maintenance login can assume it only from an OS-postgres peer socket.
ALTER ROLE stella_bootstrap NOLOGIN PASSWORD NULL;
SELECT 'CREATE ROLE stella_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_maintenance')
\gexec
ALTER ROLE stella_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD NULL;
GRANT stella_bootstrap TO stella_maintenance WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- Prepend authentication rules before any entrypoint-generated trust rules.
-- COPY CSV with unused control delimiters preserves tabs and quotes in HBA.
-- Read into psql first: opening COPY's destination truncates the same file.
SELECT E'local all stella_maintenance peer map=stella_maintenance\nhost all stella_bootstrap,stella_maintenance 0.0.0.0/0 reject\nhost all stella_bootstrap,stella_maintenance ::/0 reject\n' AS hba_prefix,
       E'stella_maintenance postgres stella_maintenance\n' AS ident_prefix,
       pg_read_file(current_setting('hba_file')) AS hba_contents,
       pg_read_file(current_setting('ident_file')) AS ident_contents
\gset
SELECT format('COPY (SELECT line FROM unnest(string_to_array(rtrim(%L, E''\n''), E''\n'')) AS lines(line) WHERE line <> '''') TO %L WITH (FORMAT csv, DELIMITER E''\x01'', QUOTE E''\x02'')',
  CASE WHEN starts_with(:'hba_contents', :'hba_prefix') THEN :'hba_contents'
    ELSE :'hba_prefix' || :'hba_contents' END, current_setting('hba_file'))
\gexec
SELECT format('COPY (SELECT line FROM unnest(string_to_array(rtrim(%L, E''\n''), E''\n'')) AS lines(line) WHERE line <> '''') TO %L WITH (FORMAT csv, DELIMITER E''\x01'', QUOTE E''\x02'')',
  CASE WHEN starts_with(:'ident_contents', :'ident_prefix') THEN :'ident_contents'
    ELSE :'ident_prefix' || :'ident_contents' END, current_setting('ident_file'))
\gexec
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pg_ident_file_mappings WHERE error IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid bootstrap peer authentication configuration';
  END IF;
END $$;
SELECT pg_reload_conf();
ALTER ROLE stella_maintenance LOGIN;

-- The application owner has no membership in either maintenance role.
SELECT 'CREATE ROLE stella NOLOGIN NOSUPERUSER NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella')
\gexec
SELECT format('GRANT stella TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', :'owner')
\gexec

-- Migrations run as a superuser may rely on implicit SET rights instead of
-- recording memberships. Restore required runtime roles on owner cutover.
SELECT format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', rolname, :'owner')
FROM pg_roles
WHERE rolname IN ('stella_ingestion', 'stella_public_sanctions_reader')
  AND NOT pg_has_role(:'owner', oid, 'SET')
\gexec
-- Read protected settings for parity checks and other sessions' statistics
-- for the migration load gate, without pg_monitor's table-scanning functions.
SELECT format('GRANT pg_read_all_settings, pg_read_all_stats TO %I', :'owner')
\gexec
CREATE EXTENSION IF NOT EXISTS unaccent;
-- Instrumentation is outside the application schema managed by Drizzle.
CREATE SCHEMA IF NOT EXISTS stella_instrumentation;
REVOKE ALL ON SCHEMA stella_instrumentation FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA stella_instrumentation TO %I', :'owner')
\gexec
-- Native development toolchains may omit optional statement instrumentation.
SELECT 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA stella_instrumentation'
WHERE EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements')
\gexec
SELECT 'ALTER EXTENSION pg_stat_statements SET SCHEMA stella_instrumentation'
FROM pg_extension
WHERE extname = 'pg_stat_statements'
  AND extnamespace <> 'stella_instrumentation'::regnamespace
\gexec
-- Statistics are maintenance data; privileges follow the extension's schema.
SELECT format('REVOKE SELECT ON %I.%I FROM PUBLIC; GRANT SELECT ON %I.%I TO %I',
  namespace.nspname, relation.relname, namespace.nspname, relation.relname, :'owner')
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
JOIN pg_depend dependency ON dependency.classid = 'pg_class'::regclass
  AND dependency.objid = relation.oid AND dependency.deptype = 'e'
JOIN pg_extension extension ON dependency.refclassid = 'pg_extension'::regclass
  AND dependency.refobjid = extension.oid
WHERE extension.extname = 'pg_stat_statements' AND relation.relkind IN ('r', 'v')
\gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB', :'owner')
\gexec
