import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import {
  createDryScopedQuery,
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// ── Shared RLS test fixture ─────────────────────────────
//
// Builds on the global PGlite singleton from test-utils.ts
// and adds RLS-specific test data seeding. All RLS test
// files share one seeded database.

type RlsFixture = {
  testDb: TestDatabase;
  ids: TestIds;
  scopedQuery: ReturnType<typeof createScopedQuery>;
  dryScopedQuery: ReturnType<typeof createDryScopedQuery>;
};

let fixturePromise: Promise<RlsFixture> | null = null;
let refCount = 0;

const initFixture = async (): Promise<RlsFixture> => {
  const testDb = await getTestDb();
  const ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  const scopedQuery = createScopedQuery(testDb);
  const dryScopedQuery = createDryScopedQuery(testDb);
  return { testDb, ids, scopedQuery, dryScopedQuery };
};

/**
 * Acquire the shared RLS fixture. The PGlite instance is
 * created on first call; subsequent calls await the same
 * promise.
 */
// eslint-disable-next-line require-await
export const getRlsFixture = async (): Promise<RlsFixture> => {
  refCount++;

  fixturePromise ??= initFixture();

  return fixturePromise;
};

/**
 * Release the shared RLS fixture. When the last consumer
 * releases, the underlying PGlite instance ref is released.
 */
export const releaseRlsFixture = async (): Promise<void> => {
  refCount--;
  if (refCount <= 0 && fixturePromise) {
    fixturePromise = null;
    refCount = 0;
    await releaseTestDb();
  }
};
