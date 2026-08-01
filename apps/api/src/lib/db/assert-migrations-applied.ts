import { sql } from "drizzle-orm";
import nodePath from "node:path";

import { rootDb } from "@/api/db/root";
import { assertMigrationHistory } from "@/api/lib/db/migration-history";
import { logger } from "@/api/lib/observability/logger";

import { assertOnlineMigrationsApplied } from "../../db/online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(process.cwd(), "drizzle");
const ESCAPE_HATCH_ENV = "SKIP_MIGRATION_CHECK";

type AppliedMigrationRow = { hash: string };

const queryAppliedHashes = async (): Promise<Set<string>> => {
  // Compare on `hash` (always populated) rather than `name` (NULL
  // on rows applied by older drizzle versions). Hash is the SHA-256
  // of the migration.sql contents at apply time, so a mismatch
  // also catches a file edited after it was applied.
  const result = await rootDb.execute<AppliedMigrationRow>(
    sql`SELECT hash FROM drizzle.__drizzle_migrations`,
  );
  return new Set(result.map((row) => row.hash));
};

export const assertMigrationsApplied = async (): Promise<void> => {
  if (process.env[ESCAPE_HATCH_ENV] === "true") {
    logger.warn("startup.migration_check_disabled", {
      escape_hatch_env: ESCAPE_HATCH_ENV,
    });
    return;
  }

  await assertMigrationHistory({
    context: "startup",
    migrationsDir: MIGRATIONS_DIR,
    queryAppliedHashes,
    remedy:
      `Run \`bun run db:migrate\` against this database, or set ${ESCAPE_HATCH_ENV}=true ` +
      "to bypass the check (emergency only).",
  });
  await assertOnlineMigrationsApplied({
    reserve: async () => {
      const connection = await rootDb.$client.reserve();
      return {
        execute: async (query, params = []) => {
          await connection.unsafe(query, [...params]);
        },
        query: async (query, params = []) =>
          await connection.unsafe(query, [...params]),
        release: () => connection.release(),
      };
    },
  });
};
