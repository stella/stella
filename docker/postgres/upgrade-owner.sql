-- Run only for the documented postgres-to-stella_owner cutover. The service
-- secret must contain the password from the application's existing URL.
\set ECHO none
\getenv owner_password POSTGRES_PASSWORD
\if :{?owner_password}
\else
\echo 'POSTGRES_PASSWORD must contain the existing database login password.'
\quit 1
\endif

\i /docker-entrypoint-initdb.d/init.sql

-- MD5 verifiers include the role name. Rename and replace the verifier in one
-- transaction, excluding both the password and verifier from statement logs.
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_duration = off;
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_duration_sample = -1;
SET LOCAL log_min_error_statement = 'panic';
ALTER ROLE postgres RENAME TO stella_owner;
SET LOCAL password_encryption = 'scram-sha-256';
SELECT format('ALTER ROLE stella_owner PASSWORD %L', :'owner_password')
\gexec
COMMIT;
\unset owner_password
