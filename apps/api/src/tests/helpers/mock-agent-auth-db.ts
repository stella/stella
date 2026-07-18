import { panic } from "better-result";
import { mock } from "bun:test";

import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The agent-auth handler suite drives the real better-auth flow (email-OTP
// sign-in, org creation, sessions) plus direct control-plane writes, all
// through the `rootDb`/`rlsDb` singletons. The api test job runs with no
// external Postgres — every other DB-backed test uses the in-memory PGlite
// singleton — so point rootDb/rlsDb at that same instance here. Without this
// the agent-auth requests hit a non-existent localhost:5432 and fail with
// `ERR_POSTGRES_CONNECTION_CLOSED`.
//
// Importing this helper also marks the test file for process isolation:
// run-tests.ts detects the `mock.module` (directly or through a helper) and
// runs the importer in its own process, so this module mock cannot leak into
// the shared-process batch.

let testDb: TestDatabase | undefined;

/**
 * Create (once) and return the PGlite-backed database the agent-auth tests run
 * against. Call this in a top-level `beforeAll` before any handler request or
 * `rootDb` access, so the proxy below resolves to a ready instance.
 */
export const initAgentAuthTestDb = async (): Promise<TestDatabase> => {
  testDb ??= await getTestDb();
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
  testDb = undefined;
  await releaseTestDb();
};

const requireTestDb = (): TestDatabase =>
  testDb ??
  panic("initAgentAuthTestDb() must run in beforeAll before rootDb is used");

// A stable proxy that forwards every access to the PGlite database resolved at
// call time. A plain getter cannot be used: bun captures a mocked binding's
// value once (before `initAgentAuthTestDb` has run), so a statically-imported
// `rootDb` would freeze to `undefined`. The proxy defers resolution to each
// property read and binds methods to the real db so drizzle's `this` is intact.
//
// SAFETY (assertion below): the proxy delegates every access to a real
// TestDatabase, so the branded type is sound; there is no non-cast way to type
// a forwarding proxy.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const lazyDbProxy = new Proxy(
  {},
  {
    get: (_target, property) => {
      const db = requireTestDb();
      const value: unknown = Reflect.get(db, property, db);
      // SAFETY: forwarding an arbitrary drizzle member is dynamic by nature;
      // methods are bound to the real db so `this` stays intact.
      // oxlint-disable-next-line typescript/no-unsafe-return
      return typeof value === "function" ? value.bind(db) : value;
    },
  },
) as TestDatabase;

void mock.module("@/api/db/root", () => ({
  rootDb: lazyDbProxy,
  rlsDb: lazyDbProxy,
}));
