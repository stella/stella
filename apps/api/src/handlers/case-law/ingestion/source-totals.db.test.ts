import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  relations,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import {
  readSourceReportedTotals,
  refreshSourceStoredTotal,
  setSourceReportedTotal,
  SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

// ── the stored count ──────────────────────────────────────────────────────
//
// The same module owns the numerator, and what is asserted here is again the
// writer's invariant rather than the column: it counts at most once per
// interval, a count it cannot finish leaves the previous figure standing, and
// a replay converges instead of fighting a concurrent worker.

const NOW = new Date("2026-09-19T12:00:00.000Z");

const seedCountedSource = async (rows: number) => {
  const id = createSafeId<"caseLawSource">();
  const adapterKey = `stored-total-${id}`;
  await db
    .insert(caseLawSources)
    .values({ id, adapterKey, name: "stored total fixture" });
  if (rows > 0) {
    await db.insert(caseLawDecisions).values(
      Array.from({ length: rows }, (_, index) => ({
        caseNumber: `${adapterKey}-${index}`,
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId: id,
      })),
    );
  }
  return id;
};

const readStoredPair = async (sourceId: SafeId<"caseLawSource">) =>
  (
    await db
      .select({
        storedTotal: caseLawSources.storedTotal,
        storedTotalAsOf: caseLawSources.storedTotalAsOf,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, sourceId))
      .limit(1)
  ).at(0);

test("the first cycle counts the source and stamps the pair", async () => {
  const sourceId = await seedCountedSource(3);

  expect(await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW })).toBe(
    "refreshed",
  );
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 3,
    storedTotalAsOf: NOW,
  });
});

test("a source counted within the interval is not recounted", async () => {
  const sourceId = await seedCountedSource(2);
  await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW });

  // The corpus grows, but the interval has not elapsed.
  await db.insert(caseLawDecisions).values({
    caseNumber: `${sourceId}-late`,
    country: "CZE",
    court: "Court",
    language: "cs",
    sourceId,
  });
  const withinInterval = new Date(
    NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS - 1,
  );

  expect(
    await refreshSourceStoredTotal({ scopedDb, sourceId, now: withinInterval }),
  ).toBe("fresh");
  // Proven by the figure, not by the return value: the old count stands.
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 2,
    storedTotalAsOf: NOW,
  });
});

test("the interval's own boundary recounts", async () => {
  const sourceId = await seedCountedSource(1);
  await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW });
  await db.insert(caseLawDecisions).values({
    caseNumber: `${sourceId}-second`,
    country: "CZE",
    court: "Court",
    language: "cs",
    sourceId,
  });
  const atBoundary = new Date(
    NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
  );

  expect(
    await refreshSourceStoredTotal({ scopedDb, sourceId, now: atBoundary }),
  ).toBe("refreshed");
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 2,
    storedTotalAsOf: atBoundary,
  });
});

test("replaying a refresh is a fixed point", async () => {
  const sourceId = await seedCountedSource(4);
  await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW });
  const first = await readStoredPair(sourceId);

  await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW });

  expect(await readStoredPair(sourceId)).toEqual(first);
});

test("a count that cannot finish leaves the previous figure standing", async () => {
  const sourceId = await seedCountedSource(2);
  await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW });
  const past = new Date(
    NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS * 2,
  );

  // A handle whose count throws, standing in for the statement timeout: the
  // caller must see "unavailable" rather than an exception, and the stored
  // pair must be exactly what the successful cycle wrote.
  const failing: ScopedDb = async (callback) =>
    await callback(
      // Only the two members below are reached before the throw, which is
      // what the refresh has to survive; `asTestRaw` owns the cast.
      asTestRaw<Transaction>({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ asOf: NOW }],
            }),
          }),
        }),
        execute: async () => {
          throw Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" },
          );
        },
      }),
    );

  const warn = spyOn(logger, "warn");
  try {
    expect(
      await refreshSourceStoredTotal({
        scopedDb: failing,
        sourceId,
        now: past,
      }),
    ).toBe("unavailable");
    // The warning is the only trace the failure leaves, so it has to say
    // what went wrong: the SQLSTATE, not just that something was thrown.
    expect(warn).toHaveBeenCalledWith(
      "case_law.source_stored_total.unavailable",
      expect.objectContaining({ sourceId, "error.cause.pg_code": "57014" }),
    );
  } finally {
    warn.mockRestore();
  }
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 2,
    storedTotalAsOf: NOW,
  });
});

// ── the role that actually runs it ────────────────────────────────────────
//
// Every test above runs as the database owner, which holds every column. In
// production this module runs as `stella_ingestion`, whose UPDATE on
// `case_law_sources` is granted column by column, so a column added without a
// grant is refused with 42501 and the refresh reports "unavailable" rather
// than raising. That is how `stored_total` shipped: counted on every cycle,
// written on none. These run the real writers under the real role.

const ingestionScopedDb: ScopedDb = async (callback) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    // SAFETY: pglite's transaction stands in for the one the helper expects.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite transaction is the test's transaction
    return await callback(tx as unknown as Transaction);
  });

test("the ingestion role counts a source and writes the stored pair", async () => {
  const sourceId = await seedCountedSource(3);
  const countedAt = new Date("2026-09-22T08:00:00.000Z");

  expect(
    await refreshSourceStoredTotal({
      scopedDb: ingestionScopedDb,
      sourceId,
      now: countedAt,
    }),
  ).toBe("refreshed");
  // A refused UPDATE would surface as "unavailable", and one that matched no
  // row as "fresh", so the figure is what proves the write landed.
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 3,
    storedTotalAsOf: countedAt,
  });
});

test("the ingestion role writes the reported trio", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  const adapterKey = `reported-total-role-${sourceId}`;
  await db
    .insert(caseLawSources)
    .values({ id: sourceId, adapterKey, name: "reported total role fixture" });
  const asOf = new Date("2026-09-22T08:30:00.000Z");

  expect(
    await setSourceReportedTotal({
      scopedDb: ingestionScopedDb,
      adapterKey,
      total: 42,
      asOf,
      origin: "adapter-poll",
    }),
  ).toBe(true);
  expect(await readTrio(adapterKey)).toEqual({
    reportedTotal: 42,
    reportedTotalAsOf: asOf,
    reportedTotalOrigin: "adapter-poll",
  });
});

test("the ingestion role is refused a source column outside the grant", async () => {
  const sourceId = await seedCountedSource(0);

  const refusal = await db
    .transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      await tx.execute(
        sql`UPDATE case_law_sources SET name = 'renamed' WHERE id = ${sourceId}`,
      );
      return "no rejection";
    })
    // Drizzle wraps the driver error, so the refusal is on the cause chain.
    .catch((error: unknown) => {
      const messages: string[] = [];
      let current = error;
      while (current instanceof Error) {
        messages.push(current.message);
        current = current.cause;
      }
      return messages.join(" | ");
    });

  expect(refusal).toContain("permission denied");
});

test("a worker holding a stale as-of loses to the one that already wrote", async () => {
  const sourceId = await seedCountedSource(5);
  const fresher = new Date(
    NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS * 3,
  );
  // The winner stamps a fresh as-of first.
  await refreshSourceStoredTotal({ scopedDb, sourceId, now: fresher });

  // The loser started its cycle earlier and carries an older `now`. Its
  // compare-and-set matches no row, so it writes nothing rather than moving
  // the figure backwards.
  expect(await refreshSourceStoredTotal({ scopedDb, sourceId, now: NOW })).toBe(
    "fresh",
  );
  expect(await readStoredPair(sourceId)).toEqual({
    storedTotal: 5,
    storedTotalAsOf: fresher,
  });
});
