import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api-postgres";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";

const allSchema = {
  ...schema,
  ...authSchema,
  ...rlsExports,
};

export type TestDatabase = ReturnType<typeof drizzle<typeof allSchema>>;
export type TestDatabaseTransaction = TransactionOf<TestDatabase>;

const createTestDb = async (): Promise<TestDatabase> => {
  const client = await PGlite.create();
  const testDb = drizzle({ client, schema: allSchema });
  const pushSchemaDb = drizzle({ client });

  await testDb.execute(sql.raw("CREATE ROLE stella NOLOGIN"));

  const { sqlStatements } = await pushSchema(allSchema, pushSchemaDb);
  for (const statement of sqlStatements) {
    await testDb.execute(sql.raw(statement));
  }

  await testDb.execute(
    sql.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO stella
    `),
  );

  return testDb;
};

// ── Shared PGlite singleton ─────────────────────────────
//
// PGlite 0.3.x uses a single-threaded WASM module. Bun's
// test runner runs files in parallel, so concurrent
// PGlite.create() calls corrupt WASM state (platform-
// independent; reproduced on both macOS and Linux CI).
// createTestDb() defaults to in-memory mode (no dataDir
// arg); the storage backend doesn't matter, it's the
// WASM init itself that races. These helpers provide a
// single lazily-initialized PGlite instance shared
// across all test files that need one.

let dbPromise: Promise<TestDatabase> | null = null;
let dbRefCount = 0;

/**
 * Acquire the shared test database. The PGlite instance
 * is created on first call; subsequent calls await the
 * same promise.
 */
// eslint-disable-next-line require-await
export const getTestDb = async (): Promise<TestDatabase> => {
  dbRefCount++;

  dbPromise ??= createTestDb();

  return dbPromise;
};

/**
 * Release the shared test database. When the last consumer
 * releases, the PGlite instance is closed.
 */
export const releaseTestDb = async (): Promise<void> => {
  dbRefCount--;
  if (dbRefCount <= 0 && dbPromise) {
    const testDb = await dbPromise;
    await testDb.$client.close();
    dbPromise = null;
    dbRefCount = 0;
  }
};

export const createScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = async <T>(
    wsIds: SafeId<"workspace">[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<T>,
  ) => await createScopedDb(testDb, wsIds, orgId)(fn);

  return scopedQuery;
};

/**
 * Like createScopedQuery, but always rolls back the
 * transaction — nothing is persisted to the database.
 */
export const createDryScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = createScopedQuery(testDb);

  const dryScopedQuery = async (
    wsIds: SafeId<"workspace">[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<void>,
  ): Promise<void> => {
    try {
      await scopedQuery(wsIds, orgId, async (tx) => {
        await fn(tx);
        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
  };

  return dryScopedQuery;
};
