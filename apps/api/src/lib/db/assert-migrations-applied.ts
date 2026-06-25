import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import nodePath from "node:path";

import { rootDb } from "@/api/db/root";
import { logger } from "@/api/lib/observability/logger";

const MIGRATIONS_DIR = nodePath.resolve(process.cwd(), "drizzle");
const ESCAPE_HATCH_ENV = "SKIP_MIGRATION_CHECK";

// Migrations intentionally rewritten after they shipped in a release. A
// database that applied the earlier version recorded its hash, and the
// migrator never re-runs an already-applied folder, so the rewritten hash is
// never stored. Accept the prior hash as satisfying the check for these.
const REWRITTEN_MIGRATION_PRIOR_HASHES: Record<string, string> = {
  // 0.5.0 backfilled slugs inside the migration and built the unique index
  // non-concurrently. The in-transaction backfill exceeded statement_timeout
  // on large corpora, so 0.5.1 rewrote it to build the index CONCURRENTLY and
  // moved the slug backfill into src/scripts/backfill-case-law-slugs.ts.
  "20260603120000_case_law_public_slugs":
    "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
};

type LocalMigration = { name: string; hash: string };
type AppliedMigrationRow = { hash: string };

const hashMigrationFile = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");

const listLocalMigrations = async (): Promise<LocalMigration[]> =>
  await Promise.all(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) =>
        existsSync(nodePath.join(MIGRATIONS_DIR, name, "migration.sql")),
      )
      .sort()
      .map(async (name) => ({
        name,
        hash: await hashMigrationFile(
          nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
        ),
      })),
  );

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

  const local = await listLocalMigrations();
  if (local.length === 0) {
    panic(
      `[startup] No migration files at ${MIGRATIONS_DIR}; refusing to start. ` +
        "The runtime image must include apps/api/drizzle/.",
    );
  }

  const appliedHashes = await queryAppliedHashes();
  const isApplied = (m: LocalMigration): boolean => {
    if (appliedHashes.has(m.hash)) {
      return true;
    }
    const priorHash = REWRITTEN_MIGRATION_PRIOR_HASHES[m.name];
    return priorHash !== undefined && appliedHashes.has(priorHash);
  };
  const missing = local.filter((m) => !isApplied(m));

  if (missing.length > 0) {
    const missingNames = missing.map((m) => m.name).join(", ");
    panic(
      `[startup] Schema drift: ${missing.length} migration(s) in code are not applied to the database. ` +
        `Code has ${local.length}; DB has ${appliedHashes.size}. ` +
        `Missing or modified after apply: ${missingNames}. ` +
        `Run \`bun run db:migrate\` against this database, or set ${ESCAPE_HATCH_ENV}=true ` +
        "to bypass the check (emergency only).",
    );
  }
};
