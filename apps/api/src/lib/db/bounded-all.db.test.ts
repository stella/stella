import { Panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { boundedAll } from "./bounded-all";

/**
 * `boundedAll` exists to keep a complete read from degrading into a
 * silent prefix, so the tests run against a real table: the bound has
 * to travel into the SQL as a `LIMIT` and the overflow probe has to
 * come back as a real row, neither of which a stubbed query proves.
 */

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const runRolledBack = async <T>(
  callback: (tx: Transaction) => Promise<T>,
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

const seedOrganizationWithTerms = async (
  tx: Transaction,
  termCount: number,
): Promise<SafeId<"organization">> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);

  await tx.insert(organization).values({
    id: organizationId,
    name: "Bounded read test firm",
    slug: `bounded-all-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });

  if (termCount > 0) {
    await tx.insert(anonymizationBlacklistEntries).values(
      Array.from({ length: termCount }, (_unused, index) => ({
        id: createSafeId<"anonymizationBlacklistEntry">(),
        organizationId,
        label: "person",
        canonical: `Bounded Term ${String(index).padStart(4, "0")}`,
      })),
    );
  }

  return organizationId;
};

const readTerms = (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  limit: number,
) =>
  tx
    .select({ canonical: anonymizationBlacklistEntries.canonical })
    .from(anonymizationBlacklistEntries)
    .where(eq(anonymizationBlacklistEntries.organizationId, organizationId))
    .orderBy(asc(anonymizationBlacklistEntries.canonical))
    .limit(limit);

describe("boundedAll", () => {
  test("returns the whole set and probes one row past the bound", async () => {
    const { rows, limits } = await runRolledBack(async (tx) => {
      const organizationId = await seedOrganizationWithTerms(tx, 3);
      const limits: number[] = [];

      const rows = await boundedAll({
        invariant: "test fixture seeds three terms",
        max: 3,
        table: "anonymization_blacklist_entries",
        query: (limit) => {
          limits.push(limit);
          return readTerms(tx, organizationId, limit);
        },
      });

      return { rows, limits };
    });

    expect(rows.map((row) => row.canonical)).toEqual([
      "Bounded Term 0000",
      "Bounded Term 0001",
      "Bounded Term 0002",
    ]);
    // The set fits exactly, and the read still asked for one more row:
    // a bound-sized LIMIT could not tell "complete" from "truncated".
    expect(limits).toEqual([4]);
  });

  test("panics with the broken invariant when a row past the bound arrives", async () => {
    const thrown = await runRolledBack(async (tx) => {
      const organizationId = await seedOrganizationWithTerms(tx, 3);

      try {
        await boundedAll({
          invariant: "test fixture claims at most two terms",
          max: 2,
          table: "anonymization_blacklist_entries",
          query: (limit) => readTerms(tx, organizationId, limit),
        });
      } catch (error) {
        return error;
      }
      return null;
    });

    expect(Panic.is(thrown)).toBe(true);
    if (!Panic.is(thrown)) {
      return;
    }
    expect(thrown.message).toContain("anonymization_blacklist_entries");
    expect(thrown.message).toContain("test fixture claims at most two terms");
    expect(thrown.cause).toEqual({
      invariant: "test fixture claims at most two terms",
      table: "anonymization_blacklist_entries",
      max: 2,
      observed: 3,
    });
  });

  test("returns an empty set without probing for an invariant break", async () => {
    const rows = await runRolledBack(async (tx) => {
      const organizationId = await seedOrganizationWithTerms(tx, 0);

      return await boundedAll({
        invariant: "test fixture seeds no terms",
        max: 2,
        table: "anonymization_blacklist_entries",
        query: (limit) => readTerms(tx, organizationId, limit),
      });
    });

    expect(rows).toEqual([]);
  });
});
