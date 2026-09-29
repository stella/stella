import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
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
  SITEMAP_SHARD_SPLIT_THRESHOLD,
  sitemapRefreshBudget,
  sitemapRefreshPageSql,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import type { SitemapRefreshPhase } from "@/api/lib/case-law/sitemap-shard-refresh";
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
/** Undated decisions beyond the first, so the undated walk spans pages too. */
const EXTRA_UNDATED_DECISIONS = 30;
/** Small enough that both walks, dated and undated, take several pages. */
const SMALL_PAGE_SIZE = 7;

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
    ...Array.from({ length: EXTRA_UNDATED_DECISIONS }, (_, index) =>
      decision({ caseNumber: `${index + 1} Nd ${index + 1}/undated` }),
    ),
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
    // Three unsplit months, and the split month in its 64 buckets (with this
    // many decisions, every bucket holds some).
    expect(await refreshCaseLawSitemapShards(refreshDb)).toMatchObject({
      shards: 3 + 64,
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
    expect(buckets.map((shard) => shard.lastmod)).toContain(
      NEWEST_UPDATE.toISOString().slice(0, 10),
    );

    // The listing and the shard read must agree: every decision of the month
    // is served by exactly one listed bucket.
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

const snapshot = async () =>
  await db
    .select()
    .from(caseLawSitemapShards)
    .orderBy(
      asc(caseLawSitemapShards.country),
      asc(caseLawSitemapShards.year),
      asc(caseLawSitemapShards.month),
      asc(caseLawSitemapShards.bucket),
    );

test(
  "a refresh walked in many small pages writes the same snapshot as one large page",
  async () => {
    const whole = await refreshCaseLawSitemapShards(refreshDb, {
      pageSize: 1_000_000,
    });
    const wholeSnapshot = await snapshot();

    const paged = await refreshCaseLawSitemapShards(refreshDb, {
      pageSize: SMALL_PAGE_SIZE,
    });
    // Both walks cross page boundaries: the dated one inside the split month,
    // the undated one inside its single month.
    expect(paged.pages).toBeGreaterThan(
      (BULK_MONTH_DECISIONS + EXTRA_UNDATED_DECISIONS) / SMALL_PAGE_SIZE,
    );
    expect(paged).toMatchObject({
      largestShard: whole.largestShard,
      shards: whole.shards,
    });
    expect(await snapshot()).toEqual(wholeSnapshot);
    expect(wholeSnapshot.find((shard) => shard.year === "undated")?.total).toBe(
      1 + EXTRA_UNDATED_DECISIONS,
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "an aborted refresh leaves the previous snapshot in place",
  async () => {
    const before = await snapshot();
    const aborted = new AbortController();
    aborted.abort();
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.caseNumber, "1 Cdo 1/2020"));
    const failure = await refreshCaseLawSitemapShards(refreshDb, {
      signal: aborted.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("SchedulerAborted");
    expect(await snapshot()).toEqual(before);
  },
  DB_TEST_TIMEOUT_MS,
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

/**
 * The test handle, with every statement each transaction sends through
 * `execute` recorded, and `onExecute` called before it runs.
 */
const recordingRefreshDb = (
  onExecute: (statement: string) => void = () => {},
) => {
  const dialect = new PgDialect();
  const transactions: string[][] = [];
  const recording = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(async (tx) => {
        const sent: string[] = [];
        transactions.push(sent);
        return await work(
          new Proxy(tx, {
            get: (target, property, receiver) =>
              property === "execute"
                ? async (query: SQL) => {
                    const statement = dialect.sqlToQuery(query).sql.trim();
                    sent.push(statement);
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
  "the walk reads one snapshot, and each transaction sets its budget before it reads or writes",
  async () => {
    const recorded = recordingRefreshDb();

    const outcome = await refreshCaseLawSitemapShards(recorded.db, {
      pageSize: SMALL_PAGE_SIZE,
      poolIdleTimeoutS: 20,
    });

    // Every page in one read-only snapshot, then the swap.
    expect(outcome.pages).toBeGreaterThan(2);
    expect(recorded.transactions).toHaveLength(2);
    expect(recorded.transactions[0]?.[0]).toBe(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    for (const sent of recorded.transactions) {
      const budgetAt = sent.indexOf("SET LOCAL statement_timeout = '10000ms'");
      expect(budgetAt).toBeGreaterThanOrEqual(0);
      expect(
        sent
          .slice(0, budgetAt)
          .every((statement) => statement.startsWith("SET ")),
      ).toBe(true);
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a run aborted while it writes the snapshot rolls the write back",
  async () => {
    await refreshCaseLawSitemapShards(refreshDb);
    const before = await snapshot();
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.caseNumber, "2 Cdo 2/2020"));
    const lease = new AbortController();
    // The lease is lost after the new snapshot is inserted, before commit.
    const recorded = recordingRefreshDb((statement) => {
      if (statement.startsWith("INSERT INTO")) {
        lease.abort();
      }
    });

    const failure = await refreshCaseLawSitemapShards(recorded.db, {
      signal: lease.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("SchedulerAborted");
    expect(await snapshot()).toEqual(before);
  },
  DB_TEST_TIMEOUT_MS,
);

const pagePlan = async (phase: SitemapRefreshPhase): Promise<string> => {
  // A resumed page, so the plan covers the row comparison on the index keys.
  const [resumeFrom] = await db
    .select({
      decisionDate: caseLawDecisions.decisionDate,
      id: caseLawDecisions.id,
      sourceId: caseLawDecisions.sourceId,
      updatedAt: sql<string>`${caseLawDecisions.updatedAt}::text`,
    })
    .from(caseLawDecisions)
    .where(
      phase === "dated"
        ? sql`${caseLawDecisions.decisionDate} IS NOT NULL`
        : sql`${caseLawDecisions.decisionDate} IS NULL`,
    )
    .limit(1);
  if (!resumeFrom) {
    return panic("Expected a decision to resume the page from.");
  }
  const { sql: text, params } = new PgDialect().sqlToQuery(
    sitemapRefreshPageSql({
      country: "CZE",
      cursor: resumeFrom,
      pageSize: SMALL_PAGE_SIZE,
      phase,
    }),
  );

  // Vacuumed so the visibility map is set, as it is for most of a settled
  // corpus; the plan then shows whether the index can answer on its own.
  await client.query("VACUUM ANALYZE case_law_decisions");
  return await client.transaction(async (tx) => {
    // The seeded table is small enough that reading it whole, or through a
    // narrower index plus the heap, can still win on cost. Scans are off
    // and every page is priced the same, so the plan is chosen by pages
    // touched, as it is on a corpus of millions: the covering index alone
    // wins only if it can answer the page without the decision rows.
    await tx.query("SET LOCAL enable_seqscan = off");
    await tx.query("SET LOCAL enable_bitmapscan = off");
    await tx.query("SET LOCAL seq_page_cost = 1000");
    await tx.query("SET LOCAL random_page_cost = 1000");
    return planLines(
      await tx.query(`EXPLAIN (COSTS OFF) ${text}`, [...params]),
    ).join("\n");
  });
};

for (const phase of ["dated", "undated"] as const) {
  test(
    `a ${phase} refresh page is a bounded range of the sitemap index alone`,
    async () => {
      const plan = await pagePlan(phase);

      expect(plan).toMatch(
        /Index Only Scan using case_law_decisions_sitemap_shard_idx on case_law_decisions/u,
      );
      // The resume point and the country are where the index read starts,
      // not a filter over everything before it, and the limit stops it: the
      // index order is the page order, so nothing is sorted first.
      const scan = plan.slice(plan.indexOf("Index Only Scan"));
      expect(scan).toMatch(/Index Cond: \(\(country = .*\) AND \(ROW\(/u);
      expect(plan).toMatch(/Limit/u);
      expect(plan.slice(0, plan.indexOf("Index Only Scan"))).not.toMatch(
        /Sort Key: case_law_decisions/u,
      );
    },
    DB_TEST_TIMEOUT_MS,
  );
}
