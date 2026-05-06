import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { db } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  assertMigrationsDirectoryPresent,
  DRIZZLE_MIGRATIONS_SCHEMA,
  DRIZZLE_MIGRATIONS_TABLE,
  MIGRATIONS_DIR,
} from "@/api/lib/db/migration-config";
import { logger } from "@/api/lib/observability/logger";

const MIGRATION_LOCK_NAMESPACE = 1_398_031_692;
const MIGRATION_LOCK_ID = 1_296_648_018;

type BootMigrationTransaction = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

type BootMigrationDatabase<TTransaction extends BootMigrationTransaction> = {
  transaction: <TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

type MigrationRunner<TTransaction extends BootMigrationTransaction> = (
  tx: TTransaction,
) => Promise<void>;

const runDrizzleMigrations = async (tx: Transaction): Promise<void> => {
  const result = await migrate(tx, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsSchema: DRIZZLE_MIGRATIONS_SCHEMA,
    migrationsTable: DRIZZLE_MIGRATIONS_TABLE,
  });

  if (!result) {
    return;
  }

  panic(`Unexpected Drizzle migration init result: ${result.exitCode}`);
};

export const runBootMigrations = async <
  TTransaction extends BootMigrationTransaction,
>(
  database: BootMigrationDatabase<TTransaction>,
  runMigrations: MigrationRunner<TTransaction>,
): Promise<void> => {
  assertMigrationsDirectoryPresent();

  logger.info("startup.migrations_begin");

  await database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})`,
    );

    await runMigrations(tx);
  });

  logger.info("startup.migrations_complete");
};

export const migrateOnBoot = async (): Promise<void> => {
  await runBootMigrations(db, runDrizzleMigrations);
};
