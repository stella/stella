import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { rootDb } from "@/api/db/root";
import { logger } from "@/api/lib/observability/logger";

const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");
const ESCAPE_HATCH_ENV = "SKIP_MIGRATION_CHECK";

type LocalMigration = { name: string; hash: string };
type AppliedMigrationRow = { hash: string };

const hashMigrationFile = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const listLocalMigrations = (): LocalMigration[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => existsSync(join(MIGRATIONS_DIR, name, "migration.sql")))
    .sort()
    .map((name) => ({
      name,
      hash: hashMigrationFile(join(MIGRATIONS_DIR, name, "migration.sql")),
    }));

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

  const local = listLocalMigrations();
  if (local.length === 0) {
    throw new Error(
      `[startup] No migration files at ${MIGRATIONS_DIR}; refusing to start. ` +
        "The runtime image must include apps/api/drizzle/.",
    );
  }

  const appliedHashes = await queryAppliedHashes();
  const missing = local.filter((m) => !appliedHashes.has(m.hash));

  if (missing.length > 0) {
    const missingNames = missing.map((m) => m.name).join(", ");
    throw new Error(
      `[startup] Schema drift: ${missing.length} migration(s) in code are not applied to the database. ` +
        `Code has ${local.length}; DB has ${appliedHashes.size}. ` +
        `Missing or modified after apply: ${missingNames}. ` +
        `Run \`bunx drizzle-kit migrate\` against this database, or set ${ESCAPE_HATCH_ENV}=true ` +
        "to bypass the check (emergency only).",
    );
  }
};
