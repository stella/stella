import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Contract steps of an expand/contract schema change that must wait until
 * older readers are retired. The expand migration ships in `drizzle/`; its
 * contract SQL lives here, where the migrator never applies it, and is
 * registered with a deadline. The dated-waiver gate enforces elapsed deadlines
 * when this registry changes, while its scheduled full check alerts owners.
 * The registry test also rejects any SQL file here that is unregistered.
 *
 * To retire an entry: move the SQL into `apps/api/drizzle/<name>/migration.sql`,
 * drop the schema policies it removes, and delete the entry and the file.
 */
export type PendingContractMigration = {
  /** Directory-style name the SQL takes in `drizzle/` when it ships. */
  name: string;
  /** Last UTC day on which the step may stay pending (YYYY-MM-DD). */
  expiresAt: string;
  /** Relations whose schema contract the step changes. */
  relations: readonly string[];
};

export const PENDING_CONTRACT_MIGRATIONS_DIR = import.meta.dir;

export const PENDING_CONTRACT_MIGRATIONS = [
  {
    name: "20261029141600_case_law_coverage_summary_v1_contract",
    expiresAt: "2026-11-12",
    relations: ["case_law_coverage_summaries"],
  },
  {
    name: "20261028061200_mcp_oauth_current_state_contract",
    expiresAt: "2026-11-03",
    relations: ["mcp_oauth_state"],
  },
  {
    name: "20261015060000_case_law_decisions_base_table_contract",
    expiresAt: "2026-10-29",
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
