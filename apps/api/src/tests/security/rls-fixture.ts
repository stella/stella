import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { rootDb, rlsDb } from "@/api/db/root";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { createDesktopCredentialAuthorizers } from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
  desktopRegistryKeyConfig,
} from "@/api/lib/business-registries/desktop/config";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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
  // swallow-ok: recovers the shared teardown chain; this release still awaits the original rejection below
  fixtureReleasePromise = releasePromise.catch(() => undefined);
  await releasePromise;
};

// Infrastructure changes driver only: provider verification, device proofs,
// replay persistence, live membership and RLS use their production owners.
export const createRlsDesktopCredentials = async (
  testDb: TestDatabase,
  ids: TestIds,
) => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: drizzleAdapter(testDb, AUTH_DATABASE_ADAPTER_OPTIONS),
    plugins: [apiKey([desktopRegistryKeyConfig])],
  });
  // SAFETY: both drivers execute the same Drizzle query and transaction APIs.
  const authorizers = createDesktopCredentialAuthorizers({
    ownerDb: asTestRaw<typeof rootDb>(testDb),
    membershipDb: asTestRaw<typeof rlsDb>(testDb),
    verifyApiKey: auth.api.verifyApiKey,
    resolveMember: async (lookup) =>
      await resolveMemberAuthorization(lookup, testDb),
  });
  const mint = async (boundOrganizationId: TestIds["orgA"]) => {
    const identity = await createDesktopDeviceSigner();
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Desktop matrix",
        userId: ids.userA1,
        expiresIn: null,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: boundOrganizationId,
          deviceJkt: identity.deviceJkt,
          inactivityExpiresAt: new Date(
            Date.now() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
          ).toISOString(),
        },
      },
    });
    return {
      signRequest: async (request: Request) => {
        request.headers.set("authorization", `Bearer ${created.key}`);
        return await identity.signRequest({ request, credential: created.key });
      },
    };
  };
  return { ...authorizers, a: await mint(ids.orgA), b: await mint(ids.orgB) };
};
