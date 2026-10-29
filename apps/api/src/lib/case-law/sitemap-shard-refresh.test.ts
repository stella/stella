import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { compareCodeUnit } from "@stll/collation";
import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
} from "@/api/handlers/case-law/decisions/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions-sql";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  refreshCaseLawSitemapShards,
  SITEMAP_SHARD_SPLIT_THRESHOLD,
  SITEMAP_WHOLE_COUNTRY,
  sitemapMonthCountSql,
  sitemapRefreshBudget,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import {
  decisionBucketSqlFor,
  decisionMonthSqlFor,
  decisionYearSqlFor,
  SITEMAP_ALL_BUCKET,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { isRecord } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const removableId = createSafeId<"caseLawDecision">();
/** One month past the split threshold, so the refresh lists it by bucket. */
const BULK_MONTH_DECISIONS = SITEMAP_SHARD_SPLIT_THRESHOLD + 100;
const NEWEST_UPDATE = new Date("2024-07-02T09:30:00.000Z");
const EXTRA_UNDATED_DECISIONS = 30;
const LISTING_ONLY_METADATA = {
  [PARTIAL_OBSERVATION_KEY]: {
    [PARTIAL_OBSERVATION_FIELD.CASE_NUMBER_IS_PLACEHOLDER]: false,
    [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
  },
};
const OPEN_DESCRIPTOR = null;
const CLOSED_DESCRIPTOR = {
  allowsDerivedAi: false,
  allowsRedistribution: false,
  attribution: null,
  license: "restricted",
} as const;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let refreshDb: RefreshDb;
let caseLawDb: CaseLawPublicReadDb;
let caseNumbers = 0;

const decision = (
  overrides: Partial<typeof caseLawDecisions.$inferInsert> = {},
): typeof caseLawDecisions.$inferInsert => {
  caseNumbers += 1;
  return {
    id: createSafeId<"caseLawDecision">(),
    sourceId: openSourceId,
    caseNumber: `${caseNumbers} Cdo ${caseNumbers}/2020`,
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    decisionDate: null,
    ...overrides,
  };
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // SAFETY: the refresh reads and writes through the root handle's
  // transaction surface, which the PGlite handle provides.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test database stands in for the root pool
  refreshDb = db as unknown as RefreshDb;
  const readDb = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the reads use.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await read(tx);
    });
  // SAFETY: brand-only wrapper around the read-role transaction helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test database carries the production read boundary
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db.insert(caseLawSources).values([
    caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
    caseLawSourceRow({
      adapterKey: "closed",
      descriptor: CLOSED_DESCRIPTOR,
      id: closedSourceId,
      name: "closed",
    }),
  ]);

  await db.insert(caseLawDecisions).values([
    decision({ decisionDate: "2020-03-15" }),
    decision({ decisionDate: "2020-03-28" }),
    decision({ decisionDate: "2021-01-10", id: removableId }),
    decision(),
    ...Array.from({ length: EXTRA_UNDATED_DECISIONS }, () => decision()),
    // Not published: the publisher listed it and never served the document.
    decision({ decisionDate: "2019-07-01", metadata: LISTING_ONLY_METADATA }),
    // Not redistributable: its source withholds redistribution.
    decision({ decisionDate: "2018-02-01", sourceId: closedSourceId }),
    // Not a public country: counted, never listed.
    decision({ country: "XAA", decisionDate: "2017-05-05", language: "xx" }),
  ]);
  await db.insert(caseLawDecisions).values(
    Array.from({ length: BULK_MONTH_DECISIONS }, (_, index) =>
      decision({
        decisionDate: `2024-06-${String((index % 28) + 1).padStart(2, "0")}`,
        updatedAt:
          index === 0 ? NEWEST_UPDATE : new Date("2024-07-01T00:00:00.000Z"),
      }),
    ),
  );
}, propertyTestTimeout(DB_TEST_TIMEOUT_MS)); // timeout: the full schema push runs on an embedded Postgres

afterAll(async () => {
  await client.close();
});

const listedShards = async () => {
  const listed = await listSitemapShardsHandler(caseLawDb);
  if (!("items" in listed)) {
    return panic("Expected the sitemap index to list shards.");
  }
  return listed.items;
};

type Shard = {
  country: string;
  year: string;
  month: string;
  bucket: string;
  total: number;
  lastModifiedMs: number;
};

const byShardKey = (a: Shard, b: Shard) =>
  compareCodeUnit(
    `${a.country}|${a.year}|${a.month}|${a.bucket}`,
    `${b.country}|${b.year}|${b.month}|${b.bucket}`,
  );

/** The shard table as the refresh left it. */
const snapshot = async (): Promise<Shard[]> =>
  (await db.select().from(caseLawSitemapShards))
    .map(({ lastModifiedAt, ...shard }) => ({
      ...shard,
      lastModifiedMs: lastModifiedAt.getTime(),
    }))
    .toSorted(byShardKey);

const bucketCountSchema = (raw: unknown) => {
  if (
    !isRecord(raw) ||
    typeof raw["country"] !== "string" ||
    typeof raw["year"] !== "string" ||
    typeof raw["month"] !== "string" ||
    typeof raw["bucket"] !== "string" ||
    typeof raw["total"] !== "number" ||
    typeof raw["last_modified_ms"] !== "number"
  ) {
    return panic("Unexpected recount row");
  }
  return {
    country: raw["country"],
    year: raw["year"],
    month: raw["month"],
    bucket: raw["bucket"],
    total: raw["total"],
    lastModifiedMs: raw["last_modified_ms"],
  };
};

/**
 * The shard table a full recount of the whole corpus writes, computed here
 * in one grouped read and split by month total, independently of the change
 * log and of the refresh's month-at-a-time path.
 */
const fullRecount = async (): Promise<Shard[]> => {
  const buckets = executedRows(
    await db.execute(sql`
      SELECT
        ${caseLawDecisions.country} AS country,
        ${decisionYearSqlFor(caseLawDecisions)} AS year,
        ${decisionMonthSqlFor(caseLawDecisions)} AS month,
        ${decisionBucketSqlFor(caseLawDecisions)} AS bucket,
        count(*)::int AS total,
        (extract(epoch FROM max(${caseLawDecisions.updatedAt})) * 1000)::float8 AS last_modified_ms
      FROM ${caseLawDecisions}
      INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${caseLawDecisions.sourceId}
      WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
        AND ${redistributableCaseLawSource}
      GROUP BY 1, 2, 3, 4
    `),
  ).map(bucketCountSchema);
  const months = Map.groupBy(
    buckets,
    ({ country, year, month }) => `${country}|${year}|${month}`,
  );
  return [...months.values()]
    .flatMap((monthBuckets): Shard[] => {
      const total = monthBuckets.reduce((sum, row) => sum + row.total, 0);
      if (total > SITEMAP_SHARD_SPLIT_THRESHOLD) {
        return monthBuckets;
      }
      const first = monthBuckets[0] ?? panic("A month has no buckets");
      return [
        {
          ...first,
          bucket: SITEMAP_ALL_BUCKET,
          total,
          lastModifiedMs: Math.max(
            ...monthBuckets.map((row) => row.lastModifiedMs),
          ),
        },
      ];
    })
    .toSorted(byShardKey);
};

/** One run, and how many log rows it left for the next. */
const refreshOnce = async (
  ...args: Parameters<typeof refreshCaseLawSitemapShards>
) => {
  const outcome = await refreshCaseLawSitemapShards(...args);
  const [left] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(caseLawSitemapChanges);
  return { outcome, left: left?.rows ?? 0 };
};

/**
 * Consecutive runs, as the scheduler's continuations and its next hourly
 * runs would make them, until one finishes with nothing left logged. A month
 * a run has already worked waits for the next run if it is logged again
 * meanwhile (as a whole-country expansion logs it).
 */
const refreshUntilDone = async (
  ...args: Parameters<typeof refreshCaseLawSitemapShards>
) => {
  for (let run = 0; run < 1000; run += 1) {
    // db-await-in-loop: consecutive scheduler runs, each continuing from the rows still logged
    const { outcome, left } = await refreshOnce(...args);
    if (outcome.type === "refreshed" && left === 0) {
      return { outcome, runs: run + 1 };
    }
  }
  return panic("The refresh never finished");
};

const expectMatchesFullRecount = async () => {
  await refreshUntilDone(refreshDb);
  expect(await snapshot()).toEqual(await fullRecount());
};

const loggedMonths = async () =>
  (
    await db
      .select({
        country: caseLawSitemapChanges.country,
        year: caseLawSitemapChanges.year,
        month: caseLawSitemapChanges.month,
      })
      .from(caseLawSitemapChanges)
      .orderBy(asc(caseLawSitemapChanges.id))
  ).map(({ country, year, month }) => `${country}/${year}/${month}`);

/** A clock that has spent any budget by the next reading. */
const spentClock = () => {
  let now = 0;
  return () => {
    now += Number.MAX_SAFE_INTEGER / 4;
    return now;
  };
};

test(
  "the index reads only the shard table, so it lists nothing before a refresh",
  async () => {
    expect(await listedShards()).toEqual([]);
    // Every published decision's month is logged once, by its inserting
    // transaction; the unpublished one is not.
    expect(await loggedMonths()).not.toContain("CZE/2019/07");
    expect(await loggedMonths()).toContain("CZE/2024/06");
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a refresh lists each published, redistributable month of a public country once",
  async () => {
    // Three unsplit months, and the split month in its 64 buckets (with this
    // many decisions, every bucket holds some). XAA is counted, not listed.
    const { outcome } = await refreshUntilDone(refreshDb);
    expect(outcome).toMatchObject({ shards: 3 + 64 });
    expect(await loggedMonths()).toEqual([]);
    expect(await snapshot()).toEqual(await fullRecount());

    const shards = await listedShards();
    const unsplit = shards.filter((shard) => shard.bucket === "all");
    expect(
      unsplit.map(({ country, year, month }) => `${country}/${year}/${month}`),
    ).toEqual(["cze/undated/00", "cze/2021/01", "cze/2020/03"]);
    expect(unsplit.every((shard) => shard.lastmod !== null)).toBe(true);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a month past the split threshold is listed by bucket, and its buckets hold every decision",
  async () => {
    const buckets = (await listedShards()).filter(
      (shard) => shard.year === "2024" && shard.month === "06",
    );
    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets.every((shard) => /^[0-9]{2}$/u.test(shard.bucket))).toBe(
      true,
    );
    expect(buckets.map((shard) => shard.lastmod)).toContain(
      NEWEST_UPDATE.toISOString().slice(0, 10),
    );
    const served = new Set<string>();
    for (const shard of buckets) {
      // db-await-in-loop: one shard read per listed bucket, as a crawler would fetch them
      const page = await listSitemapShardDecisionsHandler(shard, caseLawDb);
      if (!("items" in page)) {
        panic("Expected a listed bucket to be readable.");
      }
      for (const item of page.items) {
        served.add(item.id);
      }
    }
    expect(served.size).toBe(BULK_MONTH_DECISIONS);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a split month shrinks back to one row below the threshold, and splits again above it",
  async () => {
    const june = and(
      eq(caseLawDecisions.country, "CZE"),
      sql`${caseLawDecisions.decisionDate} >= '2024-06-01' AND ${caseLawDecisions.decisionDate} < '2024-07-01'`,
    );
    const moved = (
      await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(june)
    )
      .slice(0, 200)
      .map(({ id }) => id);
    await db
      .update(caseLawDecisions)
      .set({ decisionDate: "2024-05-31" })
      .where(inArray(caseLawDecisions.id, moved));
    await expectMatchesFullRecount();
    const juneRows = (await snapshot()).filter(
      (shard) => shard.year === "2024" && shard.month === "06",
    );
    expect(juneRows).toEqual([
      expect.objectContaining({
        bucket: SITEMAP_ALL_BUCKET,
        total: BULK_MONTH_DECISIONS - 200,
      }),
    ]);

    await db
      .update(caseLawDecisions)
      .set({ decisionDate: "2024-06-30" })
      .where(inArray(caseLawDecisions.id, moved));
    await expectMatchesFullRecount();
    expect(
      (await snapshot()).filter(
        (shard) => shard.year === "2024" && shard.month === "06",
      ).length,
    ).toBeGreaterThan(1);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a deleted month's rows leave the shard table",
  async () => {
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, removableId));
    expect(await loggedMonths()).toEqual(["CZE/2021/01"]);
    await expectMatchesFullRecount();
    const shards = await listedShards();
    expect(shards.some((shard) => shard.year === "2021")).toBe(false);
    expect(shards.some((shard) => shard.year === "2020")).toBe(true);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

const insertOne = async (
  overrides: Partial<typeof caseLawDecisions.$inferInsert> = {},
): Promise<SafeId<"caseLawDecision">> => {
  const row = decision(overrides);
  await db.insert(caseLawDecisions).values(row);
  return row.id ?? panic("A test decision has an id");
};

const updateOne = async (
  id: SafeId<"caseLawDecision">,
  set: Partial<typeof caseLawDecisions.$inferInsert>,
) => {
  await db.update(caseLawDecisions).set(set).where(eq(caseLawDecisions.id, id));
};

test(
  "every write that moves a decision's shard logs the months it touched, and a refresh matches a full recount",
  async () => {
    await refreshUntilDone(refreshDb);
    const id = await insertOne({ decisionDate: "2022-04-10" });
    expect(await loggedMonths()).toEqual(["CZE/2022/04"]);
    await expectMatchesFullRecount();

    // Re-dated across months: the month it left and the month it entered.
    await updateOne(id, { decisionDate: "2022-09-01" });
    expect(await loggedMonths()).toEqual(["CZE/2022/04", "CZE/2022/09"]);
    await expectMatchesFullRecount();

    // Redacted, then restored.
    await updateOne(id, { redactedAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(await loggedMonths()).toEqual(["CZE/2022/09"]);
    await expectMatchesFullRecount();
    await updateOne(id, { redactedAt: null });
    expect(await loggedMonths()).toEqual(["CZE/2022/09"]);
    await expectMatchesFullRecount();

    // Listing-only, then served again.
    await updateOne(id, { metadata: LISTING_ONLY_METADATA });
    expect(await loggedMonths()).toEqual(["CZE/2022/09"]);
    await expectMatchesFullRecount();
    await updateOne(id, { metadata: {} });
    await expectMatchesFullRecount();

    // Moved to another country.
    await updateOne(id, { country: "XAA" });
    expect(await loggedMonths()).toEqual(["CZE/2022/09", "XAA/2022/09"]);
    await expectMatchesFullRecount();

    // Only its last modification moved: the shard's lastmod follows.
    await updateOne(id, { updatedAt: new Date("2026-02-03T04:05:06.000Z") });
    expect(await loggedMonths()).toEqual(["XAA/2022/09"]);
    await expectMatchesFullRecount();

    // Undated, then deleted.
    await updateOne(id, { decisionDate: null });
    expect(await loggedMonths()).toEqual(["XAA/2022/09", "XAA/undated/00"]);
    await expectMatchesFullRecount();
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, id));
    expect(await loggedMonths()).toEqual(["XAA/undated/00"]);
    await expectMatchesFullRecount();
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "writes that leave every shard as it was log nothing",
  async () => {
    await refreshUntilDone(refreshDb);
    const published = await insertOne({ decisionDate: "2022-05-05" });
    const unpublished = await insertOne({
      decisionDate: "2022-05-06",
      metadata: LISTING_ONLY_METADATA,
    });
    await refreshUntilDone(refreshDb);
    // Raw statements, so the ORM's updated_at stamp does not move the shard.
    // A column the shard does not read.
    await db.execute(
      sql`UPDATE ${caseLawDecisions} SET court = 'Ústavní soud' WHERE id = ${published}`,
    );
    // A decision unpublished before and after.
    await db.execute(
      sql`UPDATE ${caseLawDecisions} SET decision_date = '2022-06-06', updated_at = '2026-03-03T00:00:00Z' WHERE id = ${unpublished}`,
    );
    // A metadata change that keeps the publication.
    await db.execute(
      sql`UPDATE ${caseLawDecisions} SET metadata = '{"note": "kept"}'::jsonb WHERE id = ${published}`,
    );
    expect(await loggedMonths()).toEqual([]);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "one transaction logs each month once, however many decisions it writes",
  async () => {
    await refreshUntilDone(refreshDb);
    const ids = await Promise.all(
      Array.from({ length: 5 }, async () =>
        insertOne({ decisionDate: "2023-02-02" }),
      ),
    );
    await refreshUntilDone(refreshDb);

    await db.transaction(async (tx) => {
      // Two statements, every decision of the month in each.
      await tx
        .update(caseLawDecisions)
        .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
        .where(inArray(caseLawDecisions.id, ids));
      await tx
        .update(caseLawDecisions)
        .set({ updatedAt: new Date("2026-01-02T00:00:00.000Z") })
        .where(inArray(caseLawDecisions.id, ids));
    });
    expect(await loggedMonths()).toEqual(["CZE/2023/02"]);
    await expectMatchesFullRecount();

    await db.transaction(async (tx) => {
      await tx
        .update(caseLawDecisions)
        .set({ decisionDate: "2023-03-03" })
        .where(inArray(caseLawDecisions.id, ids));
    });
    expect(await loggedMonths()).toEqual(["CZE/2023/02", "CZE/2023/03"]);
    await expectMatchesFullRecount();
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a source's redistribution change recounts every country",
  async () => {
    await refreshUntilDone(refreshDb);
    await db
      .update(caseLawSources)
      .set({ descriptor: OPEN_DESCRIPTOR })
      .where(eq(caseLawSources.id, closedSourceId));
    expect(await loggedMonths()).toEqual([
      `${SITEMAP_WHOLE_COUNTRY}/${SITEMAP_WHOLE_COUNTRY}/${SITEMAP_WHOLE_COUNTRY}`,
    ]);
    await refreshUntilDone(refreshDb);
    expect(await loggedMonths()).toEqual([]);
    expect(await snapshot()).toEqual(await fullRecount());
    expect(
      (await snapshot()).some(
        (shard) => shard.year === "2018" && shard.month === "02",
      ),
    ).toBe(true);

    // A change that keeps the gate logs nothing.
    await db
      .update(caseLawSources)
      .set({ descriptor: { ...CLOSED_DESCRIPTOR, allowsRedistribution: true } })
      .where(eq(caseLawSources.id, closedSourceId));
    expect(await loggedMonths()).toEqual([]);

    await db
      .update(caseLawSources)
      .set({ descriptor: CLOSED_DESCRIPTOR })
      .where(eq(caseLawSources.id, closedSourceId));
    await expectMatchesFullRecount();
    expect(
      (await snapshot()).some(
        (shard) => shard.year === "2018" && shard.month === "02",
      ),
    ).toBe(false);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a whole-country row rebuilds that country, dropping months it no longer holds",
  async () => {
    await refreshUntilDone(refreshDb);
    // A stale row for a month the country never held.
    await db.insert(caseLawSitemapShards).values({
      bucket: SITEMAP_ALL_BUCKET,
      country: "CZE",
      lastModifiedAt: new Date("2000-01-01T00:00:00.000Z"),
      month: "01",
      total: 7,
      year: "1999",
    });
    await db.insert(caseLawSitemapChanges).values({
      country: "CZE",
      year: SITEMAP_WHOLE_COUNTRY,
      month: SITEMAP_WHOLE_COUNTRY,
    });
    await expectMatchesFullRecount();
    expect(await loggedMonths()).toEqual([]);
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a whole-country row larger than one run's budget finishes over successive runs",
  async () => {
    await refreshUntilDone(refreshDb);
    await db.insert(caseLawSitemapChanges).values({
      country: "CZE",
      year: SITEMAP_WHOLE_COUNTRY,
      month: SITEMAP_WHOLE_COUNTRY,
    });
    const first = await refreshCaseLawSitemapShards(refreshDb, {
      clock: spentClock(),
    });
    // The expansion is the run's one unit: it logs every month and consumes
    // the whole-country row in one write, so no later run starts it over.
    expect(first).toEqual({ type: "pending", months: 0 });
    const logged = await loggedMonths();
    expect(logged).not.toContain(
      `CZE/${SITEMAP_WHOLE_COUNTRY}/${SITEMAP_WHOLE_COUNTRY}`,
    );
    expect(logged.length).toBeGreaterThan(3);
    expect(logged.every((month) => month.startsWith("CZE/"))).toBe(true);

    const { runs } = await refreshUntilDone(refreshDb, {
      clock: spentClock(),
    });
    // One month per run.
    expect(runs).toBe(logged.length);
    expect(await loggedMonths()).toEqual([]);
    expect(await snapshot()).toEqual(await fullRecount());
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "a run that spends its budget stops between months, and the next runs finish",
  async () => {
    await expectMatchesFullRecount();
    // Oldest log row first: January, then February, then March.
    await insertOne({ decisionDate: "2015-01-01" });
    await insertOne({ decisionDate: "2015-02-01" });
    await insertOne({ decisionDate: "2015-03-01" });
    const before = await snapshot();

    const first = await refreshCaseLawSitemapShards(refreshDb, {
      clock: spentClock(),
    });
    expect(first).toEqual({ type: "pending", months: 1 });
    expect(await loggedMonths()).toEqual(["CZE/2015/02", "CZE/2015/03"]);
    expect((await snapshot()).length).toBe(before.length + 1);

    const { runs } = await refreshUntilDone(refreshDb, {
      clock: spentClock(),
    });
    // Each run recounts one month and stops before the next.
    expect(runs).toBe(2);
    expect(await snapshot()).toEqual(await fullRecount());
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "an aborted refresh changes nothing and leaves the log for the next run",
  async () => {
    await refreshUntilDone(refreshDb);
    const before = await snapshot();
    await insertOne({ decisionDate: "2014-01-01" });
    const aborted = new AbortController();
    aborted.abort();
    const failure = await refreshCaseLawSitemapShards(refreshDb, {
      signal: aborted.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("SchedulerAborted");
    expect(await snapshot()).toEqual(before);
    expect(await loggedMonths()).toEqual(["CZE/2014/01"]);
    await expectMatchesFullRecount();
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

/**
 * The test handle, with every statement each transaction sends through
 * `execute` recorded, and `onExecute` called before it runs.
 */
const recordingRefreshDb = (
  onExecute: (statement: string) => void = () => {},
) => {
  const dialect = new PgDialect();
  const transactions: { sql: string; params: unknown[] }[][] = [];
  const recording = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(async (tx) => {
        const sent: { sql: string; params: unknown[] }[] = [];
        transactions.push(sent);
        return await work(
          new Proxy(tx, {
            get: (target, property, receiver) =>
              property === "execute"
                ? async (query: SQL) => {
                    const rendered = dialect.sqlToQuery(query);
                    const statement = rendered.sql.trim();
                    sent.push({ sql: statement, params: rendered.params });
                    onExecute(statement);
                    return await target.execute(query);
                  }
                : Reflect.get(target, property, receiver),
          }),
        );
      }),
  };
  // SAFETY: forwards every call to the PGlite handle, recording the raw
  // statements each transaction sends through `execute`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recording wrapper around the test handle
  return { db: recording as unknown as RefreshDb, transactions };
};

test(
  "a run aborted while it writes a month rolls that write back",
  async () => {
    await refreshUntilDone(refreshDb);
    const before = await snapshot();
    await insertOne({ decisionDate: "2013-01-01" });
    const lease = new AbortController();
    // The lease is lost once the month is counted, before its write commits.
    const recorded = recordingRefreshDb((statement) => {
      if (statement.includes("count(*)::int AS total")) {
        lease.abort();
      }
    });
    const failure = await refreshCaseLawSitemapShards(recorded.db, {
      signal: lease.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("SchedulerAborted");
    expect(await snapshot()).toEqual(before);
    expect(await loggedMonths()).toEqual(["CZE/2013/01"]);
    await expectMatchesFullRecount();
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test(
  "each transaction sets its budget before it reads or writes",
  async () => {
    await insertOne({ decisionDate: "2012-01-01" });
    const recorded = recordingRefreshDb();
    await refreshCaseLawSitemapShards(recorded.db, { poolIdleTimeoutS: 20 });
    expect(recorded.transactions.length).toBeGreaterThan(2);
    for (const sent of recorded.transactions) {
      const budgetAt = sent.findIndex(({ sql: statement }) =>
        statement.includes("set_config('statement_timeout'"),
      );
      expect(budgetAt).toBeGreaterThanOrEqual(0);
      expect(sent[budgetAt]?.params).toContain("10000ms");
      expect(
        sent
          .slice(0, budgetAt)
          .every(
            ({ sql: statement }) =>
              statement.startsWith("SET ") ||
              statement.includes("set_config('lock_timeout'"),
          ),
      ).toBe(true);
    }
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
);

test("every refresh statement is budgeted under the pool's idle timeout", () => {
  // The pool closes a connection silent for its idle timeout, and a running
  // statement is silent, so a statement allowed to outlast it would lose its
  // connection mid-flight instead of being cancelled by the database.
  for (const idleTimeoutS of [1, 5, 20, 60, 120, 900]) {
    const { lockTimeoutMs, statementTimeoutMs } =
      sitemapRefreshBudget(idleTimeoutS);
    expect(statementTimeoutMs).toBeGreaterThan(0);
    expect(statementTimeoutMs).toBeLessThanOrEqual((idleTimeoutS * 1000) / 2);
    expect(lockTimeoutMs).toBeLessThanOrEqual(statementTimeoutMs);
  }
  // No pool timeout: the refresh keeps its own ceiling.
  expect(sitemapRefreshBudget(0).statementTimeoutMs).toBe(30_000);
});

const planLines = (explained: unknown): string[] => {
  const rows = isRecord(explained) ? explained["rows"] : explained;
  if (!Array.isArray(rows)) {
    return panic("EXPLAIN did not return plan rows");
  }
  return rows.map((row: unknown) => {
    const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof text === "string"
      ? text
      : panic("EXPLAIN row has no plan text");
  });
};

const monthCountPlan = async (
  target: Parameters<typeof sitemapMonthCountSql>[0],
): Promise<string> => {
  const { sql: text, params } = new PgDialect().sqlToQuery(
    sitemapMonthCountSql(target),
  );
  await client.query("VACUUM ANALYZE case_law_decisions");
  return await client.transaction(async (tx) => {
    // Scans are priced by pages touched, as on a corpus of millions.
    await tx.query("SET LOCAL enable_seqscan = off");
    await tx.query("SET LOCAL enable_bitmapscan = off");
    await tx.query("SET LOCAL seq_page_cost = 1000");
    await tx.query("SET LOCAL random_page_cost = 1000");
    return planLines(
      await tx.query(`EXPLAIN (COSTS OFF) ${text}`, [...params]),
    ).join("\n");
  });
};

for (const target of [
  { country: "CZE", year: "2020", month: "03" },
  { country: "CZE", year: "undated", month: "00" },
]) {
  test(
    `a month count for ${target.year}/${target.month} reads one range of the sitemap index`,
    async () => {
      const plan = await monthCountPlan(target);
      expect(plan).toMatch(
        /Index (?:Only )?Scan using case_law_decisions_sitemap_shard_published_idx on case_law_decisions/u,
      );
      expect(plan).not.toMatch(/Seq Scan on case_law_decisions/u);
      const scan = plan.slice(plan.indexOf("case_law_decisions_sitemap_shard"));
      expect(scan).toMatch(
        target.year === "undated"
          ? /Index Cond: \(\((?:country|\(country\)::text) = .*\) AND \(decision_date IS NULL\)(?: AND \(source_id = case_law_sources.id\))?\)/u
          : /Index Cond: \(\((?:country|\(country\)::text) = .*\) AND \(decision_date >= .*\) AND \(decision_date < .*\)\)/u,
      );
    },
    propertyTestTimeout(DB_TEST_TIMEOUT_MS), // timeout: an embedded Postgres runs each statement and the schema push in WASM
  );
}

type Operation =
  | { kind: "insert"; month: number; dated: boolean; closed: boolean }
  | { kind: "delete"; pick: number }
  | { kind: "redate"; pick: number; month: number }
  | { kind: "redact"; pick: number }
  | { kind: "listingOnly"; pick: number }
  | { kind: "touch"; pick: number }
  | { kind: "country"; pick: number }
  | { kind: "gate" }
  | { kind: "refresh" };

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    month: fc.integer({ min: 1, max: 4 }),
    dated: fc.boolean(),
    closed: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("delete" as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant("redate" as const),
    pick: fc.nat(),
    month: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({ kind: fc.constant("redact" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("listingOnly" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("touch" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("country" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("gate" as const) }),
  fc.record({ kind: fc.constant("refresh" as const) }),
);

test(
  "any sequence of writes interleaved with refreshes ends equal to a full recount",
  async () => {
    await refreshUntilDone(refreshDb);
    const pool: SafeId<"caseLawDecision">[] = [];
    let stamp = 0;
    const picked = (pick: number) =>
      pool.length === 0 ? undefined : pool[pick % pool.length];
    const flip = async (
      id: SafeId<"caseLawDecision"> | undefined,
      column: "redactedAt" | "metadata",
    ) => {
      if (id === undefined) {
        return;
      }
      const [row] = await db
        .select({
          redactedAt: caseLawDecisions.redactedAt,
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, id));
      if (row === undefined) {
        return;
      }
      await updateOne(
        id,
        column === "redactedAt"
          ? {
              redactedAt:
                row.redactedAt === null
                  ? new Date("2026-01-01T00:00:00.000Z")
                  : null,
            }
          : {
              metadata:
                isRecord(row.metadata) &&
                PARTIAL_OBSERVATION_KEY in row.metadata
                  ? {}
                  : LISTING_ONLY_METADATA,
            },
      );
    };
    const apply = async (step: Operation) => {
      stamp += 1;
      switch (step.kind) {
        case "insert":
          pool.push(
            await insertOne({
              country: "XPR",
              decisionDate: step.dated ? `2011-0${step.month}-15` : null,
              language: "xx",
              sourceId: step.closed ? closedSourceId : openSourceId,
            }),
          );
          return;
        case "delete": {
          const id = picked(step.pick);
          if (id !== undefined) {
            pool.splice(pool.indexOf(id), 1);
            await db
              .delete(caseLawDecisions)
              .where(eq(caseLawDecisions.id, id));
          }
          return;
        }
        case "redate": {
          const id = picked(step.pick);
          if (id !== undefined) {
            await updateOne(id, { decisionDate: `2011-0${step.month}-20` });
          }
          return;
        }
        case "redact":
          await flip(picked(step.pick), "redactedAt");
          return;
        case "listingOnly":
          await flip(picked(step.pick), "metadata");
          return;
        case "touch": {
          const id = picked(step.pick);
          if (id !== undefined) {
            await updateOne(id, {
              updatedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, stamp)),
            });
          }
          return;
        }
        case "country": {
          const id = picked(step.pick);
          if (id !== undefined) {
            const [row] = await db
              .select({ country: caseLawDecisions.country })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, id));
            await updateOne(id, {
              country: row?.country === "XPR" ? "XPQ" : "XPR",
            });
          }
          return;
        }
        case "gate": {
          const [source] = await db
            .select({ descriptor: caseLawSources.descriptor })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, closedSourceId));
          await db
            .update(caseLawSources)
            .set({
              descriptor:
                source?.descriptor === null
                  ? CLOSED_DESCRIPTOR
                  : OPEN_DESCRIPTOR,
            })
            .where(eq(caseLawSources.id, closedSourceId));
          return;
        }
        case "refresh":
          await refreshCaseLawSitemapShards(refreshDb, { clock: spentClock() });
          return;
        default:
          step satisfies never;
      }
    };
    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { minLength: 1, maxLength: 12 }),
        async (steps) => {
          for (const step of steps) {
            // db-await-in-loop: the writes run in the generated order, each its own transaction
            await apply(step);
          }
          await refreshUntilDone(refreshDb);
          expect(await snapshot()).toEqual(await fullRecount());
          expect(await loggedMonths()).toEqual([]);
        },
      ),
      propertyConfig({ numRuns: 25 }),
    );
  },
  propertyTestTimeout(DB_TEST_TIMEOUT_MS * 3), // timeout: 25 generated write sequences, each refreshed and recounted on an embedded Postgres
);
