import { Panic, panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, gt } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readBounded, readCursorPage } from "./read-bounded";

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
        if (cap > 0) {
          const traversed: typeof expectedRows = [];
          let cursor: string | undefined;
          for (;;) {
            const page = await readCursorPage(
              testDb
                .select({ canonical: anonymizationBlacklistEntries.canonical })
                .from(anonymizationBlacklistEntries)
                .where(
                  and(
                    eq(
                      anonymizationBlacklistEntries.organizationId,
                      organizationId,
                    ),
                    cursor === undefined
                      ? undefined
                      : gt(anonymizationBlacklistEntries.canonical, cursor),
                  ),
                )
                .orderBy(asc(anonymizationBlacklistEntries.canonical)),
              {
                limit: cap,
                cursorForItem: ({ canonical }) => canonical,
              },
            );
            expect(page.items.length).toBeLessThanOrEqual(cap);
            expect(page.nextCursor !== null).toBe(
              count - traversed.length > cap,
            );
            expect(page.items).toEqual(
              expectedRows.slice(traversed.length, traversed.length + cap),
            );
            traversed.push(...page.items);
            if (page.nextCursor === null) {
              expect(page.nextCursor).toBeNull();
              break;
            }
            expect(page.items).toHaveLength(cap);
            const lastItem = page.items.at(-1);
            if (lastItem === undefined) {
              panic("A continuing cursor page must contain an item");
            }
            expect(page.nextCursor).toBe(lastItem.canonical);
            cursor = page.nextCursor;
          }
          expect(traversed).toEqual(expectedRows);
        }
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
    const pageRejection: unknown = await readCursorPage(query, {
      limit: cap,
      cursorForItem: () => "unused",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pageRejection).toBeInstanceOf(Panic);
    expect(queried).toBe(false);
  });
});

test("cursor pages reject a zero limit before querying", async () => {
  let queried = false;
  const rejection: unknown = await readCursorPage(
    {
      limit: async () => {
        queried = true;
        return [];
      },
    },
    { limit: 0, cursorForItem: () => "unused" },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Panic);
  expect(queried).toBe(false);
});
