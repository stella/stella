import { panic } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import nodePath from "node:path";

// Relative imports (not the `@/api` alias): this script ships as a loose
// file in the runtime image, which has no tsconfig to resolve paths.
import { resolveDatabaseUrl } from "../db-url";
import { assertMigrationHistory } from "../lib/db/migration-history";
import {
  CORPUS_SCHEMA_LANE_LOCK_STATEMENTS,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { runOnlineMigrations } from "./online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";

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
// role already exists (local dev, prod, reruns). The inner exception handler
// absorbs the duplicate-role race if two bootstraps ever run concurrently;
// the existence check alone is check-then-act. `unaccent` is not bootstrapped
// here: the migration that uses it self-runs `CREATE EXTENSION IF NOT EXISTS
// unaccent`. `stella_ingestion` likewise self-creates in its own migration.
const bootstrapRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = '${APPLICATION_RLS_ROLE_NAME}'
  ) THEN
    BEGIN
      CREATE ROLE ${APPLICATION_RLS_ROLE_NAME} NOLOGIN;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = '${APPLICATION_RLS_ROLE_NAME}'
      AND (rolcanlogin OR rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'reserved RLS role ${APPLICATION_RLS_ROLE_NAME} must be NOLOGIN, NOSUPERUSER, and NOBYPASSRLS';
  END IF;
  IF CURRENT_USER <> '${APPLICATION_RLS_ROLE_NAME}'
     AND NOT pg_has_role(CURRENT_USER, '${APPLICATION_RLS_ROLE_NAME}', 'SET') THEN
    EXECUTE format(
      'GRANT ${APPLICATION_RLS_ROLE_NAME} TO %I WITH SET TRUE',
      CURRENT_USER
    );
  END IF;
END
$$;
`;

// Resolve migrationsFolder relative to *this module's own location*, not
// `process.cwd()`. The entrypoint ships in two shapes that run with
// different working directories: the loose source file
// (apps/api/src/db/migrate.ts, cwd = /app/apps/api) and the bundled
// single-file build (apps/api/src/db/migrate.js, invoked directly with
// `bun <path>` and no fixed cwd). `import.meta.dir` tracks the file's own
// directory in both shapes — including inside a `bun build --target bun`
// bundle, which preserves the entrypoint's original build-time path — so
// walking up two levels (src/db -> src -> apps/api) and into `drizzle`
// lands on the same migrations folder either way. Keep the bundle's COPY
// destination two directories above its drizzle/ copy to preserve this.
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
type AppliedMigrationRow = { hash: string };

// The corpus schema lane, exclusive, for the whole upgrade: the schema
// migrations and the online phase both run DDL on the corpus tables. Taking
// it here waits for the corpus batches in flight and holds every new one at
// its boundary until the upgrade releases the lane (see
// corpus-schema-lane.ts). The lock is session-scoped, so everything runs on
// one reserved connection: a pool would hand later statements a replacement
// connection, and the lock with it, if the first one closed.
let laneHeld = false;
const connection = await client.reserve();
try {
  await connection.unsafe(bootstrapRoleSql);
  const [liftTimeout, takeLane, restoreTimeout] =
    CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
  await connection.unsafe(liftTimeout);
  await connection.unsafe(takeLane);
  laneHeld = true;
  await connection.unsafe(restoreTimeout);
  const database = drizzle({ client: connection });
  await migrate(database, { migrationsFolder });
  await assertMigrationHistory({
    context: "migrate",
    migrationsDir: migrationsFolder,
    queryAppliedHashes: async () => {
      const rows = await database.execute<AppliedMigrationRow>(
        sql`SELECT hash FROM drizzle.__drizzle_migrations`,
      );
      return new Set(rows.map(({ hash }) => hash));
    },
    remedy: "Migration completion requires every bundled migration hash.",
  });
  // The same reserved connection, released once below with the lane; the
  // phase's own release is therefore nothing.
  const onlineConnection: OnlineMigrationConnection = {
    execute: async (query, params = []) => {
      await connection.unsafe(query, [...params]);
    },
    query: async (query, params = []) =>
      await connection.unsafe(query, [...params]),
    release: (): void => undefined,
  };
  await runOnlineMigrations({
    reserve: async () => await Promise.resolve(onlineConnection),
  });
  // eslint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface (no app logger in this minimal-env task)
  console.info("[migrate] migrations applied");
} catch (error) {
  // eslint-disable-next-line no-console -- migrate CLI entrypoint; surface the failure to the deploy log
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
} finally {
  if (laneHeld) {
    await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
  }
  connection.release();
  await client.end();
}
