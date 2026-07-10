import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db";
import { clauseCategories, clauses } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { listClausesHandler } from "@/api/handlers/clauses/read";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const categoryId = toSafeId<"clauseCategory">(Bun.randomUUIDv7());
const seededClauseIds: SafeId<"clause">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
  await testDb.insert(clauseCategories).values({
    id: categoryId,
    organizationId: ids.orgA,
    name: "Cursor ordering",
  });
});

afterAll(async () => {
  if (seededClauseIds.length > 0) {
    await testDb.delete(clauses).where(inArray(clauses.id, seededClauseIds));
  }
  await testDb
    .delete(clauseCategories)
    .where(inArray(clauseCategories.id, [categoryId]));
  await releaseRlsFixture();
});

const seedClausesWithinOneMillisecond = async (count: number) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: toSafeId<"clause">(Bun.randomUUIDv7()),
    timestamp: `2026-07-10T08:15:30.123${index.toString().padStart(3, "0")}`,
    title: `Cursor ordering ${index}`,
  }));
  seededClauseIds.push(...rows.map(({ id }) => id));

  await Promise.all(
    rows.map(async ({ id, timestamp, title }) => {
      await testDb.execute(sql`
        insert into clauses (
          id,
          organization_id,
          category_id,
          title,
          body,
          created_by,
          created_at,
          updated_at
        ) values (
          ${id},
          ${ids.orgA},
          ${categoryId},
          ${title},
          ${JSON.stringify([])}::jsonb,
          ${ids.userA1},
          ${timestamp}::timestamp,
          ${timestamp}::timestamp
        )
      `);
    }),
  );

  return rows;
};

describe("clause cursor ordering", () => {
  test("returns every row exactly once across page boundaries", async () => {
    const rows = await seedClausesWithinOneMillisecond(12);
    const expectedIds = rows
      .map(({ id }) => id)
      .toSorted()
      .toReversed();
    const collectedIds: string[] = [];
    let cursor: string | undefined;
    const readPage = async (pageCursor: string | undefined) =>
      await Result.gen(() =>
        listClausesHandler({
          safeDb,
          organizationId: ids.orgA,
          query: {
            categoryId,
            limit: 3,
            ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
          },
        }),
      );

    for (let pageNumber = 0; pageNumber < 12; pageNumber++) {
      // oxlint-disable-next-line no-await-in-loop -- each cursor comes from the preceding page
      const result = await readPage(cursor);
      if (Result.isError(result)) {
        throw result.error;
      }

      collectedIds.push(...result.value.items.map(({ id }) => id));
      cursor = result.value.nextCursor ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }

    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(rows.length);
  });
});
