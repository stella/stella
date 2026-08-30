import { oauthResource } from "@/api/db/auth-schema";
import { rlsDb, rootDb } from "@/api/db/root";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The agent-auth handler suite drives the real better-auth flow (email-OTP
// sign-in, org creation, sessions) plus direct control-plane writes, all
// through the root database adapter boundary. The api test job runs with no
// external Postgres, so the boundary delegates to the real PGlite test
// database for the lifetime of this suite.

let testDb: TestDatabase | undefined;
const ROOT_DATABASE_MEMBERS = [
  "delete",
  "execute",
  "insert",
  "query",
  "select",
  "transaction",
  "update",
] as const;
const originalRootDescriptors = new Map(
  ROOT_DATABASE_MEMBERS.map((member) => [
    member,
    Object.getOwnPropertyDescriptor(rootDb, member),
  ]),
);
const originalRlsTransactionDescriptor = Object.getOwnPropertyDescriptor(
  rlsDb,
  "transaction",
);

const installDatabaseBoundary = (database: TestDatabase) => {
  Object.defineProperties(rootDb, {
    delete: { configurable: true, value: database.delete.bind(database) },
    execute: { configurable: true, value: database.execute.bind(database) },
    insert: { configurable: true, value: database.insert.bind(database) },
    query: { configurable: true, value: database.query },
    select: { configurable: true, value: database.select.bind(database) },
    transaction: {
      configurable: true,
      value: database.transaction.bind(database),
    },
    update: { configurable: true, value: database.update.bind(database) },
  });
  Object.defineProperty(rlsDb, "transaction", {
    configurable: true,
    value: database.transaction.bind(database),
  });
};

const restoreDatabaseBoundary = () => {
  for (const [member, descriptor] of originalRootDescriptors) {
    if (descriptor) {
      Object.defineProperty(rootDb, member, descriptor);
      continue;
    }
    Reflect.deleteProperty(rootDb, member);
  }
  if (originalRlsTransactionDescriptor) {
    Object.defineProperty(
      rlsDb,
      "transaction",
      originalRlsTransactionDescriptor,
    );
  } else {
    Reflect.deleteProperty(rlsDb, "transaction");
  }
};

/**
 * Create (once) and return the PGlite-backed database the agent-auth tests run
 * against. Call this in a top-level `beforeAll` before any handler request or
 * `rootDb` access, so the proxy below resolves to a ready instance.
 */
export const initAgentAuthTestDb = async (): Promise<TestDatabase> => {
  if (testDb !== undefined) {
    return testDb;
  }
  const db = await getTestDb();
  await db.insert(oauthResource).values(
    getBetterAuthOAuthResources().map((resource) => ({
      id: Bun.randomUUIDv7(),
      allowedScopes: resource.allowedScopes,
      identifier: resource.identifier,
      name: resource.name,
    })),
  );
  testDb = db;
  installDatabaseBoundary(db);
  return testDb;
};

/**
 * Release the shared PGlite database in a top-level `afterAll`. Leaving the
 * handle open keeps the test process alive with pending work, which bun exits
 * non-zero on even when every test passed.
 */
export const releaseAgentAuthTestDb = async (): Promise<void> => {
  if (testDb === undefined) {
    return;
  }
  restoreDatabaseBoundary();
  testDb = undefined;
  await releaseTestDb();
};
