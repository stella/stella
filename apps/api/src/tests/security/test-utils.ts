import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabaseMarker, TransactionOf } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const allRelations = {
  ...schema.relations,
  ...authSchema.authRelationsPart,
};

type RawTestDatabase = ReturnType<typeof drizzle<typeof allRelations>>;
export type TestDatabase = RawTestDatabase & RlsDatabaseMarker;
export type TestDatabaseTransaction = TransactionOf<TestDatabase>;

// Roles, schema, workspace-access objects, and grants all arrive with the
// client (snapshot-booted or fully built in pglite-test-db); this wrapper
// only adds the relations-aware drizzle instance and the RLS marker.
const createTestDb = async (): Promise<TestDatabase> => {
  const client = await createTestPglite();
  return markRlsDatabase(
    drizzle({
      client,
      relations: allRelations,
    }),
  );
};

const DEFAULT_TEST_USER_ID = toSafeId<"user">("user_test");

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
let dbClosePromise = Promise.resolve();
let dbRefCount = 0;

/**
 * Acquire the shared test database. The PGlite instance
 * is created on first call; subsequent calls await the
 * same promise.
 */
export const getTestDb = async (): Promise<TestDatabase> => {
  dbRefCount += 1;
  dbPromise ??= dbClosePromise.then(createTestDb);

  return await dbPromise;
};

/**
 * Release the shared test database. Detach the closing instance before the
 * asynchronous close starts; a later acquisition then waits for that close
 * before creating a replacement instead of receiving a closing client.
 */
export const releaseTestDb = async (): Promise<void> => {
  dbRefCount -= 1;
  if (dbRefCount > 0 || !dbPromise) {
    return;
  }

  const closingDbPromise = dbPromise;
  dbPromise = null;
  dbRefCount = 0;
  const closePromise = dbClosePromise.then(async () => {
    const testDb = await closingDbPromise;
    await testDb.$client.close();
    return undefined;
  });
  // Preserve the failure for this release call, but recover the shared chain
  // so one failed initialization or close cannot poison every later test.
  dbClosePromise = closePromise.catch(() => undefined);
  await closePromise;
};

export const createScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = async <T>(
    wsIds: SafeId<"workspace">[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<T>,
    userId: SafeId<"user"> = DEFAULT_TEST_USER_ID,
  ) => await createScopedDb(testDb, wsIds, orgId, userId)(fn);

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
    userId: SafeId<"user"> = DEFAULT_TEST_USER_ID,
  ): Promise<void> => {
    try {
      await scopedQuery(
        wsIds,
        orgId,
        async (tx) => {
          await fn(tx);
          tx.rollback();
        },
        userId,
      );
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
  };

  return dryScopedQuery;
};
