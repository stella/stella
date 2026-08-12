import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortableTx, transactionAbortError } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * The mechanism every converted handler now depends on: a rejection raised
 * inside a transaction callback has to abort the transaction, and the abort has
 * to reach the caller as the same error the handler used to build by hand.
 *
 * Returning that rejection instead commits it, which is the whole defect class;
 * only a real transaction distinguishes the two, so this suite runs against a
 * live database rather than a mocked handle.
 */

let testDb: TestDatabase;
const seededOrganizationIds: SafeId<"organization">[] = [];

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (seededOrganizationIds.length > 0) {
    await testDb
      .delete(organization)
      .where(inArray(organization.id, seededOrganizationIds));
  }
  await releaseTestDb();
});

const seedOrganization = async (): Promise<SafeId<"organization">> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Transaction abort organization",
      slug: `tx-abort-${Bun.randomUUIDv7()}`,
      createdAt: new Date(),
    });
  });
  seededOrganizationIds.push(organizationId);
  return organizationId;
};

/**
 * A `SafeDb` over the test database, matching the scoped factories' contract:
 * anything the callback throws that is not a driver error comes back wrapped,
 * carrying the thrown value as its cause.
 */
const testSafeDb: SafeDb = async (fn) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await fn(asTestRaw<Transaction>(tx));
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

const workspaceCount = async (organizationId: SafeId<"organization">) =>
  await testDb.$count(
    workspaces,
    eq(workspaces.organizationId, organizationId),
  );

const insertWorkspace = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await tx.insert(workspaces).values({
    id: toSafeId<"workspace">(Bun.randomUUIDv7()),
    organizationId,
    name: "Abort matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });
};

// The control: without it, "nothing was written" would also pass on a callback
// that writes nothing at all.
test("a callback that returns commits the rows it wrote", async () => {
  const organizationId = await seedOrganization();

  const outcome = await abortableTx(testSafeDb, async (tx) => {
    await insertWorkspace(tx, organizationId);
    return { ok: true };
  });

  expect(Result.isOk(outcome)).toBe(true);
  expect(await workspaceCount(organizationId)).toBe(1);
});

test("a HandlerError thrown after a write rolls that write back", async () => {
  const organizationId = await seedOrganization();

  const outcome = await abortableTx(testSafeDb, async (tx) => {
    await insertWorkspace(tx, organizationId);
    throw new HandlerError({ status: 400, message: "Matter limit reached" });
  });

  expect(Result.isError(outcome)).toBe(true);
  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the transaction to abort");
  }

  // The response is unchanged by the abort: the handler answers with the same
  // status and message it used to build from the returned failure value.
  expect(HandlerError.is(outcome.error)).toBe(true);
  if (!HandlerError.is(outcome.error)) {
    throw new TypeError("Expected the abort to surface as a HandlerError");
  }
  expect(outcome.error.status).toBe(400);
  expect(outcome.error.message).toBe("Matter limit reached");

  expect(await workspaceCount(organizationId)).toBe(0);
});

test("a database failure is not mistaken for an abort", async () => {
  const organizationId = await seedOrganization();

  const outcome = await abortableTx(testSafeDb, async (tx) => {
    await insertWorkspace(tx, organizationId);
    // A duplicate primary key: the driver rejects, and the failure must reach
    // the caller as the database error it is, not as a handler rejection.
    const duplicateId = toSafeId<"workspace">(Bun.randomUUIDv7());
    await tx.insert(workspaces).values({
      id: duplicateId,
      organizationId,
      name: "Abort matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(workspaces).values({
      id: duplicateId,
      organizationId,
      name: "Abort matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    return { ok: true };
  });

  expect(Result.isError(outcome)).toBe(true);
  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the duplicate insert to fail");
  }
  expect(HandlerError.is(outcome.error)).toBe(false);
  expect(await workspaceCount(organizationId)).toBe(0);
});

test("transactionAbortError hands back a non-abort error unchanged", () => {
  const databaseError = new DatabaseError({ message: "connection reset" });

  expect(transactionAbortError(databaseError)).toBe(databaseError);
});
