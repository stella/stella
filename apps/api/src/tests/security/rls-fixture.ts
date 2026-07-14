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
let fixtureReleasePromise = Promise.resolve();
let fixtureRefCount = 0;

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
export const getRlsFixture = async (): Promise<RlsFixture> => {
  fixtureRefCount += 1;
  fixturePromise ??= fixtureReleasePromise.then(initFixture);

  return await fixturePromise;
};

/**
 * Release the shared RLS fixture. Serialize teardown with later acquisition
 * so the next fixture cannot reuse a database client that is still closing.
 */
export const releaseRlsFixture = async (): Promise<void> => {
  fixtureRefCount -= 1;
  if (fixtureRefCount > 0 || !fixturePromise) {
    return;
  }

  const releasedFixturePromise = fixturePromise;
  fixturePromise = null;
  fixtureRefCount = 0;
  const previousReleasePromise = fixtureReleasePromise;
  const releasePromise = (async () => {
    await previousReleasePromise;
    try {
      await releasedFixturePromise;
    } finally {
      // initFixture acquires the shared DB before it seeds RLS data. Release
      // that reference even when seeding fails.
      await releaseTestDb();
    }
  })();
  // Keep the current failure visible while allowing future test files to
  // create a fresh fixture rather than inheriting a rejected teardown chain.
  fixtureReleasePromise = releasePromise.catch(() => undefined);
  await releasePromise;
};
