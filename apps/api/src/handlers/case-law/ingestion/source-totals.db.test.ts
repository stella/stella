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

test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
  "a total of %p is refused and writes nothing",
  async (total) => {
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
  },
);

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
