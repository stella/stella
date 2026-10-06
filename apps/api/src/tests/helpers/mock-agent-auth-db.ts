import type { Logger } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import { oauthResource } from "@/api/db/auth-schema";
import { rlsDb, rootDb } from "@/api/db/root";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
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

type RootTransaction = Parameters<
  Parameters<TestDatabase["transaction"]>[0]
>[0];

// PGlite has a single connection. Production runs a root statement issued
// during an open transaction on another pooled connection; here it would wait
// for that transaction forever, so it joins the transaction instead.
const openTransaction = new AsyncLocalStorage<RootTransaction>();

const installDatabaseBoundary = (database: TestDatabase) => {
  Object.defineProperties(rootDb, {
    delete: { configurable: true, value: database.delete.bind(database) },
    execute: {
      configurable: true,
      value: async (query: Parameters<typeof database.execute>[0]) => {
        const transaction = openTransaction.getStore();
        return transaction === undefined
          ? (await database.execute(query)).rows
          : (await transaction.execute(query)).rows;
      },
    },
    insert: { configurable: true, value: database.insert.bind(database) },
    query: { configurable: true, value: database.query },
    select: { configurable: true, value: database.select.bind(database) },
    transaction: {
      configurable: true,
      value: async <T>(
        callback: (transaction: RootTransaction) => Promise<T>,
      ): Promise<T> => {
        const run = async (transaction: RootTransaction): Promise<T> =>
          await openTransaction.run(
            transaction,
            async () =>
              await callback(
                new Proxy(transaction, {
                  get: (target, property, receiver): unknown =>
                    property === "execute"
                      ? async (
                          query: Parameters<typeof transaction.execute>[0],
                        ) => (await transaction.execute(query)).rows
                      : Reflect.get(target, property, receiver),
                }),
              ),
          );
        const outer = openTransaction.getStore();
        return outer === undefined
          ? await database.transaction(run)
          : await outer.transaction(run);
      },
    },
    update: { configurable: true, value: database.update.bind(database) },
  });
  Object.defineProperty(rlsDb, "transaction", {
    configurable: true,
    value: rootDb.transaction.bind(rootDb),
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
 *
 * `logger` sees every statement the boundary runs, as the server's query
 * logger does (pass `queryCountLogger` to measure a request's count).
 */
export const initAgentAuthTestDb = async ({
  logger,
}: { logger?: Logger } = {}): Promise<TestDatabase> => {
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
  installDatabaseBoundary(
    logger === undefined ? db : withQueryLogger(db, logger),
  );
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
