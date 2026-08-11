import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawSources,
  relations,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import {
  readSourceReportedTotals,
  setSourceReportedTotal,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { createSafeId } from "@/api/lib/branded-types";

// The trio is nullable in the schema and only this module keeps it whole, so
// what is asserted here is the writer's invariant rather than the columns:
// a set lands as all three, a rewrite replaces all three, a value no
// publisher could state is refused, and a key no source carries writes
// nothing at all.

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

const { createTestPglite } = await import("@/api/tests/pglite-test-db");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the helper expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const seedSource = async (): Promise<string> => {
  const id = createSafeId<"caseLawSource">();
  const adapterKey = `source-totals-${id}`;
  await db
    .insert(caseLawSources)
    .values({ id, adapterKey, name: "source totals fixture" });
  return adapterKey;
};

const readTrio = async (adapterKey: string) =>
  (
    await db
      .select({
        reportedTotal: caseLawSources.reportedTotal,
        reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
        reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, adapterKey))
      .limit(1)
  ).at(0);

test("a set lands as the whole trio and reads back", async () => {
  const adapterKey = await seedSource();
  const asOf = new Date("2026-08-11T09:00:00.000Z");

  const applied = await setSourceReportedTotal({
    scopedDb,
    adapterKey,
    total: 903_412,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  });

  expect(applied).toBe(true);
  const rows = await readSourceReportedTotals(scopedDb);
  expect(rows.find((row) => row.adapterKey === adapterKey)).toEqual({
    adapterKey,
    reportedTotal: 903_412,
    reportedTotalAsOf: asOf,
    reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  });
});

test("a later set replaces every member, origin included", async () => {
  const adapterKey = await seedSource();
  await setSourceReportedTotal({
    scopedDb,
    adapterKey,
    total: 10,
    asOf: new Date("2026-08-01T00:00:00.000Z"),
    origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  });

  const asOf = new Date("2026-08-11T12:00:00.000Z");
  await setSourceReportedTotal({
    scopedDb,
    adapterKey,
    total: 11,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  });

  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: 11,
    reportedTotalAsOf: asOf,
    reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  });
});

// 2_147_483_648 is one past the `integer` column's range: without the
// writer's own bound it satisfies every "positive whole number" check and is
// refused by PostgreSQL instead, mid-transaction.
test.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  2_147_483_648,
])("a total of %p is refused and writes nothing", async (total) => {
  const adapterKey = await seedSource();

  const rejection = await setSourceReportedTotal({
    scopedDb,
    adapterKey,
    total,
    asOf: new Date("2026-08-11T09:00:00.000Z"),
    origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  }).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(TypeError);

  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
  });
});

// The other side of the bound: the largest value the column can hold must
// still go through, so the guard cannot drift into rejecting valid totals.
test("the column's largest value is accepted", async () => {
  const adapterKey = await seedSource();

  const applied = await setSourceReportedTotal({
    scopedDb,
    adapterKey,
    total: 2_147_483_647,
    asOf: new Date("2026-08-11T09:00:00.000Z"),
    origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  });

  expect(applied).toBe(true);
  expect((await readTrio(adapterKey))?.reportedTotal).toBe(2_147_483_647);
});

test("an adapter key no source carries reports back, and writes nothing", async () => {
  const present = await seedSource();

  const applied = await setSourceReportedTotal({
    scopedDb,
    adapterKey: `${present}-absent`,
    total: 7,
    asOf: new Date("2026-08-11T09:00:00.000Z"),
    origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  });

  expect(applied).toBe(false);
  expect(await readTrio(present)).toEqual({
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
  });
});

// The origin values live in two places by necessity: the TypeScript union and
// the column's check constraint. Exercising every declared member against the
// real constraint binds the two — a member added to one and not the other
// fails here rather than at a write.
test.each(Object.values(SOURCE_TOTAL_ORIGIN))(
  "the database accepts the declared origin %p",
  async (origin) => {
    const adapterKey = await seedSource();

    const applied = await setSourceReportedTotal({
      scopedDb,
      adapterKey,
      total: 3,
      asOf: new Date("2026-08-11T09:00:00.000Z"),
      origin,
    });

    expect(applied).toBe(true);
    expect((await readTrio(adapterKey))?.reportedTotalOrigin).toBe(origin);
  },
);

test("the database refuses an origin outside the declared set", async () => {
  const adapterKey = await seedSource();

  const rejection = await db
    .update(caseLawSources)
    .set({
      reportedTotal: 5,
      reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z"),
      // SAFETY: the point of this test is the value the union forbids, so
      // the cast is what lets the constraint be the thing under test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- exercising the database's own guard against an unlisted origin
      reportedTotalOrigin: "guessed" as SourceTotalOrigin,
    })
    .where(eq(caseLawSources.adapterKey, adapterKey))
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
  });
});

// The writer always sets the three together, so only a path that bypasses it
// can split them. That is exactly what the constraint exists for.
test.each([
  ["total alone", { reportedTotal: 5 }],
  ["date alone", { reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z") }],
  ["origin alone", { reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR }],
])("the database refuses a partial trio: %s", async (_label, patch) => {
  const adapterKey = await seedSource();

  const rejection = await db
    .update(caseLawSources)
    .set(patch)
    .where(eq(caseLawSources.adapterKey, adapterKey))
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
  });
});

test("the database refuses a non-positive total written around the writer", async () => {
  const adapterKey = await seedSource();

  const rejection = await db
    .update(caseLawSources)
    .set({
      reportedTotal: 0,
      reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z"),
      reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR,
    })
    .where(eq(caseLawSources.adapterKey, adapterKey))
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(Error);
  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: null,
    reportedTotalAsOf: null,
    reportedTotalOrigin: null,
  });
});
