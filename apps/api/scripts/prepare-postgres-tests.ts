import { TaggedError } from "better-result";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

const apiRoot = path.resolve(import.meta.dir, "..");

export class PostgresTestMigrationError extends TaggedError(
  "PostgresTestMigrationError",
)<{
  message: string;
  exitCode: number;
}> {}

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
      STELLA_MIGRATE_ONLINE_WORK: "build_finalized",
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
  const elapsedMilliseconds = (Bun.nanoseconds() - startedAt) / 1_000_000;
  process.stderr.write(
    `[test:postgres] database migration ready in ${elapsedMilliseconds.toFixed(0)}ms\n`,
  );
};
