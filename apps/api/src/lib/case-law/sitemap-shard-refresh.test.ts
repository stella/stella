import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
} from "@/api/handlers/case-law/decisions/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  refreshCaseLawSitemapShards,
  sitemapBucketCountsQuery,
  sitemapYearRange,
  SITEMAP_SHARD_SPLIT_THRESHOLD,
} from "@/api/lib/case-law/sitemap-shard-refresh";
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

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let refreshDb: RefreshDb;
let caseLawDb: CaseLawPublicReadDb;

const decision = (
  overrides: Partial<typeof caseLawDecisions.$inferInsert> & {
    caseNumber: string;
  },
): typeof caseLawDecisions.$inferInsert => ({
  id: createSafeId<"caseLawDecision">(),
  sourceId: openSourceId,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: null,
  ...overrides,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // SAFETY: the refresh reads and replaces through the root handle's select and
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
      descriptor: {
        allowsDerivedAi: false,
        allowsRedistribution: false,
        attribution: null,
        license: "restricted",
      },
      id: closedSourceId,
      name: "closed",
    }),
  ]);

  await db.insert(caseLawDecisions).values([
    decision({ caseNumber: "1 Cdo 1/2020", decisionDate: "2020-03-15" }),
    decision({ caseNumber: "2 Cdo 2/2020", decisionDate: "2020-03-28" }),
    decision({
      caseNumber: "3 Cdo 3/2021",
      decisionDate: "2021-01-10",
      id: removableId,
    }),
    decision({ caseNumber: "4 Cdo 4/undated" }),
    // Not published: the publisher listed it and never served the document.
    decision({
      caseNumber: "5 Cdo 5/2019",
      decisionDate: "2019-07-01",
      metadata: {
        [PARTIAL_OBSERVATION_KEY]: {
          [PARTIAL_OBSERVATION_FIELD.CASE_NUMBER_IS_PLACEHOLDER]: false,
          [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
        },
      },
    }),
    // Not redistributable: its source withholds redistribution.
    decision({
      caseNumber: "6 Cdo 6/2018",
      decisionDate: "2018-02-01",
      sourceId: closedSourceId,
    }),
    // Not a public country.
    decision({
      caseNumber: "synthetic-hidden",
      country: "XAA",
      decisionDate: "2017-05-05",
      language: "xx",
    }),
  ]);
  await db.insert(caseLawDecisions).values(
    Array.from({ length: BULK_MONTH_DECISIONS }, (_, index) =>
      decision({
        caseNumber: `${index + 1} Cdo ${index + 1}/2024`,
        decisionDate: `2024-06-${String((index % 28) + 1).padStart(2, "0")}`,
        updatedAt:
          index === 0 ? NEWEST_UPDATE : new Date("2024-07-01T00:00:00.000Z"),
      }),
    ),
  );
}, DB_TEST_TIMEOUT_MS);

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

test(
  "the index reads only the snapshot, so it lists nothing until a refresh",
  async () => {
    // Published decisions are seeded; only the snapshot is empty.
    expect(await listedShards()).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a refresh lists each published, redistributable month of a public country once",
  async () => {
    expect(await refreshCaseLawSitemapShards(refreshDb)).toMatchObject({
      type: "refreshed",
    });

    const shards = await listedShards();
    const unsplit = shards.filter((shard) => shard.bucket === "all");
    expect(
      unsplit.map(({ country, year, month }) => `${country}/${year}/${month}`),
    ).toEqual(["cze/undated/00", "cze/2021/01", "cze/2020/03"]);
    expect(unsplit.every((shard) => shard.lastmod !== null)).toBe(true);
  },
  DB_TEST_TIMEOUT_MS,
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
    expect(
      buckets
        .map((shard) => shard.lastmod)
        .toSorted()
        .at(-1),
    ).toBe(NEWEST_UPDATE.toISOString().slice(0, 10));

    // The listing and the shard read must agree: every decision of the month
    // is served by exactly one listed bucket.
    const served = new Set<string>();
    for (const shard of buckets) {
      // db-await-in-loop: one shard read per listed bucket, as a crawler would fetch them
      const page = await listSitemapShardDecisionsHandler(shard, caseLawDb);
      if (!("items" in page)) {
        return panic("Expected a listed bucket to be readable.");
      }
      for (const item of page.items) {
        served.add(item.id);
      }
    }
    expect(served.size).toBe(BULK_MONTH_DECISIONS);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a refresh replaces the snapshot whole",
  async () => {
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, removableId));
    await refreshCaseLawSitemapShards(refreshDb);

    const shards = await listedShards();
    expect(shards.some((shard) => shard.year === "2021")).toBe(false);
    expect(shards.some((shard) => shard.year === "2020")).toBe(true);
  },
  DB_TEST_TIMEOUT_MS,
);

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

test(
  "a year's count reads the decisions index alone, never the decision rows",
  async () => {
    const { sql: text, params } = sitemapBucketCountsQuery(
      refreshDb,
      "CZE",
      // One year out of a country's many, as the refresh reads it.
      sitemapYearRange(2020),
    ).toSQL();

    // Vacuumed so the visibility map is set, as it is for most of a settled
    // corpus; the plan then shows whether the index can answer on its own.
    await client.query("VACUUM ANALYZE case_law_decisions");
    const plan = await client.transaction(async (tx) => {
      // A scan of the whole seeded table can still win on cost; the guard is
      // about the path the planner is offered, which is what a corpus of
      // millions of decisions runs.
      await tx.query("SET LOCAL enable_seqscan = off");
      await tx.query("SET LOCAL enable_bitmapscan = off");
      return planLines(
        await tx.query(`EXPLAIN (COSTS OFF) ${text}`, [...params]),
      ).join("\n");
    });

    expect(plan).toMatch(
      /Index Only Scan using case_law_decisions_sitemap_shard_idx on case_law_decisions/u,
    );
  },
  DB_TEST_TIMEOUT_MS,
);
