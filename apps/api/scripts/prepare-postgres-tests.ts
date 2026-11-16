import { TaggedError } from "better-result";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { resolveDatabaseUrl } from "@/api/db-url";
import { createSqlClient } from "@/api/db/sql-client";
import { corpusProjectionSeedingGuardStatements } from "@/api/tests/helpers/corpus-projection-seeding-guard";

const apiRoot = path.resolve(import.meta.dir, "..");

export class PostgresTestMigrationError extends TaggedError(
  "PostgresTestMigrationError",
)<{
  message: string;
  exitCode: number;
}> {}

/**
 * The corpus projection seeding guard is on by default in the shared test
 * database, as in every PGlite test database
 * (`tests/helpers/corpus-projection-seeding-guard.ts`). A fixture that stands
 * a row up as pre-existing data turns it off for its own transaction.
 */
const installSeedingGuard = async (): Promise<void> => {
  const url = resolveDatabaseUrl();
  if (!url) {
    return;
  }
  const client = createSqlClient({ url, max: 1 });
  try {
    await client.begin(async (tx) => {
      for (const statement of corpusProjectionSeedingGuardStatements()) {
        // db-await-in-loop: a fixed handful of DDL statements in order, in one transaction.
        await tx.unsafe(statement);
      }
    });
  } finally {
    await client.close();
  }
};

/** Runs the shipped migration entrypoint against the database selected for tests. */
export const preparePostgresTests = async (): Promise<void> => {
  const startedAt = Bun.nanoseconds();
  const migration = Bun.spawn({
    cmd: [process.execPath, "run", "src/db/migrate.ts"],
    cwd: apiRoot,
    env: {
      ...process.env,
      // Postgres test databases are disposable and have no RDS load signal.
      DB_LOAD_GATE_EBS_SIGNAL:
        process.env["DB_LOAD_GATE_EBS_SIGNAL"] ?? "disabled",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await migration.exited;
  const exitCode = childExitStatus(migration);
  if (exitCode !== 0) {
    throw new PostgresTestMigrationError({
      message: `Postgres test database migration failed with exit code ${exitCode}.`,
      exitCode,
    });
  }
  await installSeedingGuard();
  const elapsedMilliseconds = (Bun.nanoseconds() - startedAt) / 1_000_000;
  process.stderr.write(
    `[test:postgres] database migration ready in ${elapsedMilliseconds.toFixed(0)}ms\n`,
  );
};
