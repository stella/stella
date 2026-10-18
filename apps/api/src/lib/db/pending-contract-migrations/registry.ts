import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Contract steps of an expand/contract schema change that must wait until
 * older readers are retired. The expand migration ships in `drizzle/`; its
 * contract SQL lives here, where the migrator never applies it, and is
 * registered with a deadline. `pending-contract-migrations.test.ts` fails once
 * the deadline passes, and whenever a SQL file here is unregistered, so the
 * step is either moved into `drizzle/` (under a fresh timestamp) or its
 * deadline is consciously renewed.
 *
 * To retire an entry: move the SQL into `apps/api/drizzle/<name>/migration.sql`,
 * drop the schema policies it removes, and delete the entry and the file.
 */
export type PendingContractMigration = {
  /** Directory-style name the SQL takes in `drizzle/` when it ships. */
  name: string;
  /** Last UTC day on which the step may stay pending (YYYY-MM-DD). */
  expiresAt: string;
  /** Relations whose reader grants and policies the step removes. */
  relations: readonly string[];
};

export const PENDING_CONTRACT_MIGRATIONS_DIR = import.meta.dir;

export const PENDING_CONTRACT_MIGRATIONS = [
  {
    name: "20261015060000_case_law_decisions_base_table_contract",
    expiresAt: "2026-10-22",
    relations: ["case_law_decisions"],
  },
] as const satisfies readonly PendingContractMigration[];

export const pendingContractSqlPath = (
  migration: PendingContractMigration,
): string =>
  nodePath.join(PENDING_CONTRACT_MIGRATIONS_DIR, `${migration.name}.sql`);

/**
 * The SQL of every pending step, in registry order. The Postgres reader test
 * applies them in a rolled back transaction to hold the step to its purpose.
 */
export const readPendingContractSources = (): string[] =>
  PENDING_CONTRACT_MIGRATIONS.map((migration) =>
    readFileSync(pendingContractSqlPath(migration), "utf-8"),
  );
