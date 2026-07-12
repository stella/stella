import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { lockWorkspacesForEntityCap } from "./entity-cap-lock";

/**
 * Every entity-creating path shares `lockWorkspacesForEntityCap` so
 * cap checks serialize with each other (issue #1139). True
 * concurrent-deadlock behavior isn't observable with the shared
 * PGlite test instance (a single-threaded WASM connection, so two
 * transactions can't actually block on each other's locks — see
 * `apps/api/src/tests/security/test-utils.ts`). What IS testable
 * without real concurrency is the invariant the whole design leans
 * on: that this function always locks a shared set of workspace ids
 * in the SAME deterministic order, no matter what order the caller
 * passes them in. If that holds, an A->B move and a concurrent B->A
 * move provably request their locks in the same order and cannot
 * form an ABBA cycle — which is the actual property #1139 asks for.
 */

// Reading `SQL.queryChunks` directly is fragile: whether a literal
// or interpolated part shows up as a raw string vs. a wrapper object
// (`StringChunk`, `Param`, ...) is a Drizzle internal that has
// already changed across versions. `PgDialect#sqlToQuery` is the
// same public compilation step Drizzle itself uses to build the
// query sent to Postgres, so it stays correct however chunks are
// represented internally — it returns the driver-bound `params`
// array, and this lock query interpolates exactly one value (the
// workspace id) per call.
const pgDialect = new PgDialect();

const lockedWorkspaceId = (query: SQL): string => {
  const { params } = pgDialect.sqlToQuery(query);
  if (params.length !== 1) {
    throw new TypeError(
      `Expected the lock query to bind exactly one param, got ${params.length}`,
    );
  }
  const [id] = params;
  if (typeof id !== "string") {
    throw new TypeError("Lock query did not interpolate a workspace id");
  }
  return id;
};

const createOrderTrackingTx = () => {
  const lockedOrder: string[] = [];
  const execute = mock(async (query: SQL) => {
    lockedOrder.push(lockedWorkspaceId(query));
    return [];
  });
  return { execute, lockedOrder, tx: { execute } };
};

describe("lockWorkspacesForEntityCap ordering", () => {
  const wsLow = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
  const wsHigh = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");

  test("locks a single workspace exactly once", async () => {
    const { execute, lockedOrder, tx } = createOrderTrackingTx();

    await lockWorkspacesForEntityCap(asTestRaw<Transaction>(tx), [wsLow]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(lockedOrder).toEqual([wsLow]);
  });

  test("dedupes a workspace id repeated in the input", async () => {
    const { execute, tx } = createOrderTrackingTx();

    await lockWorkspacesForEntityCap(asTestRaw<Transaction>(tx), [
      wsLow,
      wsLow,
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("locks two workspaces ascending when passed low-then-high", async () => {
    const { lockedOrder, tx } = createOrderTrackingTx();

    await lockWorkspacesForEntityCap(asTestRaw<Transaction>(tx), [
      wsLow,
      wsHigh,
    ]);

    expect(lockedOrder).toEqual([wsLow, wsHigh]);
  });

  test("locks two workspaces ascending when passed high-then-low — the cross-workspace move-direction case", async () => {
    const { lockedOrder, tx } = createOrderTrackingTx();

    // This is `copy-to-workspace` with `deleteSource` called for a
    // B->A move: the handler's own {source, target} pair is
    // {wsHigh, wsLow} (opposite argument order from the A->B test
    // above), but the lock order must come out identical so a
    // concurrent A->B move can't hold {wsLow} and wait on {wsHigh}
    // while this one holds {wsHigh} and waits on {wsLow}.
    await lockWorkspacesForEntityCap(asTestRaw<Transaction>(tx), [
      wsHigh,
      wsLow,
    ]);

    expect(lockedOrder).toEqual([wsLow, wsHigh]);
  });
});

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

type RolledBackTxCallback<T> = (tx: Transaction) => Promise<T>;

const runRolledBack = async <T>(
  callback: RolledBackTxCallback<T>,
): Promise<T> => {
  let value: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      // oxlint-disable-next-line node/callback-return -- must call tx.rollback() after capturing the value
      value = await callback(asTestRaw<Transaction>(tx));
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && value !== undefined) {
      return value;
    }
    throw error;
  }

  if (value === undefined) {
    throw new Error("Rolled-back test transaction did not return a value");
  }
  return value;
};

const seedTestWorkspace = async (
  tx: Transaction,
): Promise<SafeId<"workspace">> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());

  await tx.insert(organization).values({
    id: organizationId,
    name: "Entity Cap Lock Test",
    slug: `entity-cap-lock-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });
  await tx.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Entity cap lock matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });

  return workspaceId;
};

describe("lockWorkspacesForEntityCap against a real workspace row", () => {
  test("locks a single seeded workspace without error", async () => {
    const result = await runRolledBack(async (tx) => {
      const workspaceId = await seedTestWorkspace(tx);
      await lockWorkspacesForEntityCap(tx, [workspaceId]);
      return "ok" as const;
    });

    expect(result).toBe("ok");
  });

  test("locks two seeded workspaces without error, regardless of input order", async () => {
    const result = await runRolledBack(async (tx) => {
      const first = await seedTestWorkspace(tx);
      const second = await seedTestWorkspace(tx);
      const [wsLow, wsHigh] = [first, second].sort();
      if (!wsLow || !wsHigh) {
        throw new Error("Expected two seeded workspace ids");
      }

      // Passed high-then-low; the function must not error or
      // reorder incorrectly against a real `workspaces` row.
      await lockWorkspacesForEntityCap(tx, [wsHigh, wsLow]);
      return "ok" as const;
    });

    expect(result).toBe("ok");
  });
});
