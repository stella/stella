import { panic } from "better-result";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import nodePath from "node:path";

// Relative import (not the `@/api` alias): this script ships as a loose
// file in the runtime image, which has no tsconfig to resolve paths.
import { resolveDatabaseUrl } from "../db-url";

// Migrations run through Bun's SQL client — the same driver the API uses
// at runtime — so TLS is negotiated identically. The drizzle-kit CLI
// instead forces node-postgres, whose pg-connection-string maps
// `sslmode=require` to `verify-full` and then rejects the RDS private CA
// (no bundle is shipped), failing every migration with
// SELF_SIGNED_CERT_IN_CHAIN. Bun's client honours `sslmode=require`
// without that chain check, matching the runtime connection.
//
// Running the migrator programmatically (rather than via the CLI) is also
// what gives this entrypoint a deterministic exit code: a failure throws
// and exits non-zero instead of the CLI's nondeterministic exit on error.
const url = resolveDatabaseUrl();
if (!url) {
  panic(
    "migrate: no database connection; set DATABASE_URL or the DB_* components",
  );
}

const client = new SQL({ url, max: 1 });

// Bootstrap the `stella` RLS role before migrating. Managed-provider fresh
// databases (no `docker-entrypoint-initdb.d`) never run
// `docker/postgres/init.sql`, so the migrator owns role bootstrap; the RLS
// migrations only GRANT to `stella` and would fail with `role "stella" does
// not exist` on a clean DB. Keep this in parity with
// `docker/postgres/init.sql` (init.sql stays the fast path for local
// containers). Guard with a `pg_roles` lookup inside a DO block: there is no
// `CREATE ROLE IF NOT EXISTS`, and a bare `CREATE ROLE` would error when the
// role already exists (local dev, prod, reruns). `unaccent` is not bootstrapped
// here: the migration that uses it self-runs `CREATE EXTENSION IF NOT EXISTS
// unaccent`. `stella_ingestion` likewise self-creates in its own migration.
const bootstrapRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella') THEN
    CREATE ROLE stella NOLOGIN;
  END IF;
END
$$;
`;

try {
  await client.unsafe(bootstrapRoleSql);
  await migrate(drizzle({ client }), {
    // cwd is the migrate task's workingDirectory (/app/apps/api); mirrors
    // the path that assert-migrations-applied.ts checks at startup.
    migrationsFolder: nodePath.resolve(process.cwd(), "drizzle"),
  });
  // eslint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface (no app logger in this minimal-env task)
  console.info("[migrate] migrations applied");
} catch (error) {
  // eslint-disable-next-line no-console -- migrate CLI entrypoint; surface the failure to the deploy log
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
