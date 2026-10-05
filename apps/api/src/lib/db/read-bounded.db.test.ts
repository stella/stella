import { Panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readBounded } from "./read-bounded";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

describe("complete bounded reads", () => {
  test.each([
    { count: 0, cap: 2 },
    { count: 1, cap: 2 },
    { count: 2, cap: 2 },
    { count: 3, cap: 2 },
    { count: 6, cap: 2 },
    { count: 0, cap: 0 },
    { count: 1, cap: 0 },
  ])(
    "reports completeness for $count rows with a cap of $cap",
    async ({ count, cap }) => {
      const organizationId = toSafeId<"organization">(
        `org_${Bun.randomUUIDv7()}`,
      );
      await testDb.insert(organization).values({
        id: organizationId,
        name: "Bounded read test firm",
        slug: `read-bounded-${Bun.randomUUIDv7()}`,
        createdAt: new Date(),
      });

      try {
        const expectedRows = Array.from(
          { length: count },
          (_unused, index) => ({
            canonical: `Term ${index}`,
          }),
        );
        if (count > 0) {
          await testDb.insert(anonymizationBlacklistEntries).values(
            expectedRows.map(({ canonical }) => ({
              id: createSafeId<"anonymizationBlacklistEntry">(),
              organizationId,
              label: "person",
              canonical,
            })),
          );
        }

        const queryLimits: unknown[] = [];
        const readDb = withQueryLogger(testDb, {
          logQuery: (_sql, params) => {
            queryLimits.push(params.at(-1));
          },
        });
        const result = await readBounded(
          readDb
            .select({ canonical: anonymizationBlacklistEntries.canonical })
            .from(anonymizationBlacklistEntries)
            .where(
              eq(anonymizationBlacklistEntries.organizationId, organizationId),
            )
            .orderBy(asc(anonymizationBlacklistEntries.canonical)),
          cap,
        );
        if (count > cap) {
          expect(result).toEqual({ type: "overflow", cap });
        } else {
          expect(result).toEqual({ type: "complete", rows: expectedRows });
        }
        expect(queryLimits).toEqual([cap + 1]);
      } finally {
        await testDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    },
  );

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("rejects an invalid cap of %s before executing the query", async (cap) => {
    let queried = false;
    const query = {
      limit: async () => {
        queried = true;
        return [];
      },
    };

    // bun-types declares `.rejects.toBeInstanceOf` as void, so awaiting it
    // trips type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await readBounded(query, cap).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Panic);
    expect(queried).toBe(false);
  });
});
