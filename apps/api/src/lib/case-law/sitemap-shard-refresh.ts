import { panic } from "better-result";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { compareCodeUnit } from "@stll/collation";

import type { rootDb } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapMonthHorizons,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { envBase } from "@/api/env-base";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions-sql";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  decisionBucketSqlFor,
  SITEMAP_ALL_BUCKET,
  SITEMAP_UNDATED_MONTH,
  SITEMAP_UNDATED_YEAR,
} from "@/api/lib/case-law/sitemap-shard-sql";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * A month is split into buckets once it holds more than this many decisions.
 * The snapshot is as old as the last refresh while the shard read counts live
 * rows and refuses more than the URL limit, so splitting at half the limit
 * leaves a month room to grow between refreshes without its shard overflowing.
 */
export const SITEMAP_SHARD_SPLIT_THRESHOLD = Math.floor(
  LIMITS.caseLawSitemapShardUrlLimit / 2,
);

/**
 * A change-log row whose year and month are this asks for a whole country,
 * and one whose country is this asks for every country.
 */
export const SITEMAP_WHOLE_COUNTRY = "*";

/** Logged months read per statement; the run reads again once they are done. */
const PENDING_MONTHS_PER_READ = 500;

/** Both budgets in milliseconds. */
export type SitemapRefreshBudget = {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
};

/**
 * One month's count reads one country-month range of one index, and a
 * whole-country enumeration one index descent per month, so a statement that
 * runs past this is not making progress; it is cancelled and the next run
 * retries it.
 */
const MAX_STATEMENT_TIMEOUT_MS = 30_000;
/** A count takes no lock a writer holds; waiting on one is not progress. */
const MAX_LOCK_TIMEOUT_MS = 5000;

/**
 * The statement and lock budgets for one pool.
 *
 * The pool closes a connection that has been silent for its idle timeout,
 * and a statement that is still running sends nothing, so the pool would drop
 * a long statement's connection mid-flight with a driver error rather than a
 * database one. Every statement here is held under half that timeout, so the
 * database cancels a stuck statement first and the connection survives it.
 */
export const sitemapRefreshBudget = (
  poolIdleTimeoutS: number,
): SitemapRefreshBudget => {
  const statementTimeoutMs =
    poolIdleTimeoutS > 0
      ? Math.min(
          MAX_STATEMENT_TIMEOUT_MS,
          Math.floor((poolIdleTimeoutS * 1000) / 2),
        )
      : MAX_STATEMENT_TIMEOUT_MS;
  return {
    lockTimeoutMs: Math.min(MAX_LOCK_TIMEOUT_MS, statementTimeoutMs),
    statementTimeoutMs,
  };
};

type RefreshDb = Pick<typeof rootDb, "transaction">;
type RefreshTransaction = Parameters<
  Parameters<RefreshDb["transaction"]>[0]
>[0];

/** Both budgets end with the transaction. */
const setTransactionBudget = async (
  tx: RefreshTransaction,
  { lockTimeoutMs, statementTimeoutMs }: SitemapRefreshBudget,
): Promise<void> => {
  if (
    !Number.isInteger(lockTimeoutMs) ||
    !Number.isInteger(statementTimeoutMs)
  ) {
    return panic("Sitemap refresh budgets must be integer milliseconds");
  }
  await setSharedLockTimeout(tx, lockTimeoutMs);
  await setSharedStatementTimeout(tx, statementTimeoutMs);
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    panic("SchedulerAborted");
  }
};

/** One sitemap month of one country, in the shard path's text forms. */
export type SitemapMonth = { country: string; year: string; month: string };

const monthKey = ({ country, year, month }: SitemapMonth): string =>
  `${country}|${year}|${month}`;

const DATED_YEAR = /^[0-9]{4}$/u;
const DATED_MONTH = /^(?:0[1-9]|1[0-2])$/u;

/**
 * The decision dates a month covers, as a range on the index's second key:
 * a dated month is a half-open date range, the undated month the NULL dates.
 */
const monthRangeSql = ({ year, month }: SitemapMonth): SQL => {
  if (year === SITEMAP_UNDATED_YEAR && month === SITEMAP_UNDATED_MONTH) {
    return sql`${caseLawDecisions.decisionDate} IS NULL`;
  }
  if (!DATED_YEAR.test(year) || !DATED_MONTH.test(month)) {
    return panic(`Malformed sitemap month ${year}/${month}`);
  }
  const monthNumber = Number(month);
  const start = `${year}-${month}-01`;
  const end =
    monthNumber === 12
      ? `${String(Number(year) + 1).padStart(4, "0")}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return sql`${caseLawDecisions.decisionDate} >= ${start}::date AND ${caseLawDecisions.decisionDate} < ${end}::date`;
};

/**
 * One month's published decisions among the redistributable sources, counted
 * per bucket with their newest `updated_at`, with the horizon of the
 * statement's own snapshot: the oldest transaction still running when it
 * read, so every change of a transaction below it is in the count. An empty
 * month answers one row with the horizon and no bucket. The country and the
 * month's date range are the leading keys of
 * `case_law_decisions_sitemap_shard_published_idx` and the publication gate is
 * its partial predicate, so the count reads that month's index range and
 * nothing else. Exported for the plan contract.
 */
export const sitemapMonthCountSql = (target: SitemapMonth): SQL => sql`
  WITH snapshot AS (
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon
  ),
  counts AS (
    SELECT
      ${decisionBucketSqlFor(caseLawDecisions)} AS bucket,
      count(*)::int AS total,
      (extract(epoch FROM max(${caseLawDecisions.updatedAt})) * 1000)::float8 AS last_modified_ms
    FROM ${caseLawDecisions}
    INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${caseLawDecisions.sourceId}
    WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
      AND ${caseLawDecisions.country} = ${target.country}
      AND ${monthRangeSql(target)}
      AND ${redistributableCaseLawSource}
    GROUP BY 1
  )
  SELECT snapshot.horizon, counts.bucket, counts.total, counts.last_modified_ms
  FROM snapshot
  LEFT JOIN counts ON true
`;

/**
 * The months a country holds published decisions in: a loose index scan
 * that jumps from each month's first decision to the first one at or after
 * the next month's start, one descent per month, plus one probe for the
 * undated decisions. Exported for the plan contract.
 */
export const sitemapCountryMonthsSql = (country: string): SQL => sql`
  WITH RECURSIVE dated AS (
    (
      SELECT ${caseLawDecisions.decisionDate} AS decision_date
      FROM ${caseLawDecisions}
      WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
        AND ${caseLawDecisions.country} = ${country}
        AND ${caseLawDecisions.decisionDate} IS NOT NULL
      ORDER BY ${caseLawDecisions.decisionDate}
      LIMIT 1
    )
    UNION ALL
    SELECT (
      SELECT ${caseLawDecisions.decisionDate}
      FROM ${caseLawDecisions}
      WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
        AND ${caseLawDecisions.country} = ${country}
        AND ${caseLawDecisions.decisionDate} >= (date_trunc('month', dated.decision_date) + interval '1 month')::date
      ORDER BY ${caseLawDecisions.decisionDate}
      LIMIT 1
    )
    FROM dated
    WHERE dated.decision_date IS NOT NULL
  )
  SELECT to_char(dated.decision_date, 'YYYY') AS year, to_char(dated.decision_date, 'MM') AS month
  FROM dated
  WHERE dated.decision_date IS NOT NULL
  UNION ALL
  SELECT ${SITEMAP_UNDATED_YEAR} AS year, ${SITEMAP_UNDATED_MONTH} AS month
  WHERE EXISTS (
    SELECT 1
    FROM ${caseLawDecisions}
    WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
      AND ${caseLawDecisions.country} = ${country}
      AND ${caseLawDecisions.decisionDate} IS NULL
  )
`;

/**
 * The countries holding a published decision: a loose index scan, one
 * descent per country.
 */
const sitemapCountriesSql = (): SQL => sql`
  WITH RECURSIVE countries AS (
    (
      SELECT ${caseLawDecisions.country} AS country
      FROM ${caseLawDecisions}
      WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
      ORDER BY ${caseLawDecisions.country}
      LIMIT 1
    )
    UNION ALL
    SELECT (
      SELECT ${caseLawDecisions.country}
      FROM ${caseLawDecisions}
      WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
        AND ${caseLawDecisions.country} > countries.country
      ORDER BY ${caseLawDecisions.country}
      LIMIT 1
    )
    FROM countries
    WHERE countries.country IS NOT NULL
  )
  SELECT countries.country
  FROM countries
  WHERE countries.country IS NOT NULL
`;

const monthCountRowSchema = v.union([
  v.object({
    horizon: v.string(),
    bucket: v.string(),
    total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    last_modified_ms: v.number(),
  }),
  v.object({
    horizon: v.string(),
    bucket: v.null(),
    total: v.null(),
    last_modified_ms: v.null(),
  }),
]);
type BucketCount = {
  bucket: string;
  total: number;
  last_modified_ms: number;
};

const monthRowSchema = v.object({ year: v.string(), month: v.string() });

type ShardRow = typeof caseLawSitemapShards.$inferInsert;

/**
 * A month becomes one `all` row, or one row per bucket once it passes the
 * split threshold; an empty month becomes no rows.
 */
const shardRows = (
  target: SitemapMonth,
  buckets: readonly BucketCount[],
): ShardRow[] => {
  let monthTotal = 0;
  let monthLastModifiedMs = 0;
  for (const { total, last_modified_ms } of buckets) {
    monthTotal += total;
    monthLastModifiedMs = Math.max(monthLastModifiedMs, last_modified_ms);
  }
  if (monthTotal === 0) {
    return [];
  }
  const { country, year, month } = target;
  if (monthTotal > SITEMAP_SHARD_SPLIT_THRESHOLD) {
    return buckets.map(({ bucket, total, last_modified_ms }) => ({
      bucket,
      country,
      lastModifiedAt: new Date(last_modified_ms),
      month,
      total,
      year,
    }));
  }
  return [
    {
      bucket: SITEMAP_ALL_BUCKET,
      country,
      lastModifiedAt: new Date(monthLastModifiedMs),
      month,
      total: monthTotal,
      year,
    },
  ];
};

/** Change-log rows whose writers had finished before `horizon` was read. */
const finishedBefore = (horizon: string): SQL =>
  sql`${caseLawSitemapChanges.xact} < ${horizon}::xid8`;

const loggedRowsOf = (target: SitemapMonth, horizon: string): SQL =>
  and(
    eq(caseLawSitemapChanges.country, target.country),
    eq(caseLawSitemapChanges.year, target.year),
    eq(caseLawSitemapChanges.month, target.month),
    finishedBefore(horizon),
  ) ?? panic("A logged month has conditions");

type RunContext = {
  db: RefreshDb;
  budget: SitemapRefreshBudget;
  horizon: string;
  signal: AbortSignal | undefined;
};

/**
 * Recount one month and replace its shard rows.
 *
 * The count runs in its own short read-only transaction and answers the
 * horizon of its own snapshot. A short write transaction then replaces the
 * month's rows and deletes the month's log rows below that horizon, whose
 * changes the count saw; a change committed since stays logged for the next
 * run. The write is fenced: it replaces the month only when no run has
 * written a count of it from a newer snapshot, so a run that counted earlier
 * cannot overwrite a newer count after that count consumed the log rows.
 * Equal horizons are safe: a change neither count saw has a transaction id
 * at or above the horizon and stays logged. Answers whether it wrote.
 */
const recountMonth = async (
  { db, budget, signal }: RunContext,
  target: SitemapMonth,
): Promise<boolean> => {
  const counted = await withAggregateTransaction(db, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, budget);
    return executedRows(await tx.execute(sitemapMonthCountSql(target))).map(
      (row) => v.parse(monthCountRowSchema, row),
    );
  });
  const horizon =
    counted.at(0)?.horizon ?? panic("A month count answers its horizon");
  const buckets = counted.flatMap((row) => (row.bucket === null ? [] : [row]));
  const rows = shardRows(target, buckets);
  return await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    // The upsert locks the month's fence row until commit, so two runs
    // writing one month take turns and the second sees the first's horizon.
    const fenced = await tx
      .insert(caseLawSitemapMonthHorizons)
      .values({ ...target, countedHorizon: horizon })
      .onConflictDoUpdate({
        target: [
          caseLawSitemapMonthHorizons.country,
          caseLawSitemapMonthHorizons.year,
          caseLawSitemapMonthHorizons.month,
        ],
        set: { countedHorizon: sql`excluded.counted_horizon` },
        setWhere: sql`${caseLawSitemapMonthHorizons.countedHorizon} <= excluded.counted_horizon`,
      })
      .returning({ country: caseLawSitemapMonthHorizons.country });
    if (fenced.length === 0) {
      return false;
    }
    await tx
      .delete(caseLawSitemapShards)
      .where(
        and(
          eq(caseLawSitemapShards.country, target.country),
          eq(caseLawSitemapShards.year, target.year),
          eq(caseLawSitemapShards.month, target.month),
        ),
      );
    if (rows.length > 0) {
      await tx.insert(caseLawSitemapShards).values(rows);
    }
    await tx.delete(caseLawSitemapChanges).where(loggedRowsOf(target, horizon));
    // A run whose lease was lost while it wrote rolls back here.
    throwIfAborted(signal);
    return true;
  });
};

const wholeCountryRow = (country: string): SitemapMonth => ({
  country,
  year: SITEMAP_WHOLE_COUNTRY,
  month: SITEMAP_WHOLE_COUNTRY,
});

/**
 * Turn a whole-country row into one log row per month its recount covers, in
 * one short write transaction that also consumes the whole-country rows: the
 * months the country holds published decisions in, and the months its shards
 * list (an emptied month is recounted to no rows). The new rows carry this
 * transaction's id, so a later run recounts them month by month under the
 * usual horizon rule, and a country larger than one run's budget keeps its
 * progress between runs.
 */
const expandCountry = async (
  { db, budget, horizon, signal }: RunContext,
  country: string,
): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    const held = executedRows(
      await tx.execute(sitemapCountryMonthsSql(country)),
    ).map((row) => v.parse(monthRowSchema, row));
    const listed = await tx
      .selectDistinct({
        year: caseLawSitemapShards.year,
        month: caseLawSitemapShards.month,
      })
      .from(caseLawSitemapShards)
      .where(eq(caseLawSitemapShards.country, country));
    const months = new Map<string, SitemapMonth>();
    for (const { year, month } of [...held, ...listed]) {
      const target = { country, year, month };
      months.set(monthKey(target), target);
    }
    if (months.size > 0) {
      await tx
        .insert(caseLawSitemapChanges)
        .values(
          [...months.values()].toSorted((a, b) =>
            compareCodeUnit(monthKey(a), monthKey(b)),
          ),
        );
    }
    await tx
      .delete(caseLawSitemapChanges)
      .where(loggedRowsOf(wholeCountryRow(country), horizon));
    throwIfAborted(signal);
  });
};

/**
 * Turn an every-country row into one whole-country row per country, in one
 * short write transaction that also consumes the every-country rows: the
 * countries holding a published decision and those the shards list (a
 * country with no decision left is recounted to no rows).
 */
const expandEveryCountry = async ({
  db,
  budget,
  horizon,
  signal,
}: RunContext): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    const held = executedRows(await tx.execute(sitemapCountriesSql())).map(
      (row) => v.parse(v.object({ country: v.string() }), row).country,
    );
    const listed = await tx
      .selectDistinct({ country: caseLawSitemapShards.country })
      .from(caseLawSitemapShards);
    const countries = new Set([
      ...held,
      ...listed.map(({ country }) => country),
    ]);
    if (countries.size > 0) {
      await tx
        .insert(caseLawSitemapChanges)
        .values([...countries].toSorted(compareCodeUnit).map(wholeCountryRow));
    }
    await tx
      .delete(caseLawSitemapChanges)
      .where(loggedRowsOf(wholeCountryRow(SITEMAP_WHOLE_COUNTRY), horizon));
    throwIfAborted(signal);
  });
};

/** The logged months a run may consume, oldest log row first. */
const readPendingMonths = async ({
  db,
  budget,
  horizon,
}: RunContext): Promise<SitemapMonth[]> =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, budget);
    const firstId = sql<number>`min(${caseLawSitemapChanges.id})`;
    return await tx
      .select({
        country: caseLawSitemapChanges.country,
        year: caseLawSitemapChanges.year,
        month: caseLawSitemapChanges.month,
      })
      .from(caseLawSitemapChanges)
      .where(finishedBefore(horizon))
      .groupBy(
        caseLawSitemapChanges.country,
        caseLawSitemapChanges.year,
        caseLawSitemapChanges.month,
      )
      .orderBy(asc(firstId))
      .limit(PENDING_MONTHS_PER_READ);
  });

/**
 * The oldest transaction still running when the run begins. Every log row
 * below it was written by a transaction that had finished, so its decision
 * changes are visible to every later statement; rows at or above it wait for
 * a later run. Log ids are not commit order, so they never bound a run.
 */
const readHorizon = async (
  db: RefreshDb,
  budget: SitemapRefreshBudget,
): Promise<string> =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, budget);
    const [row] = executedRows(
      await tx.execute(
        sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
      ),
    );
    return v.parse(v.object({ horizon: v.string() }), row).horizon;
  });

/** The public index's size, read back for the capacity alarm. */
const readPublicShardExtent = async (
  db: RefreshDb,
  budget: SitemapRefreshBudget,
): Promise<{ largestShard: number; shards: number }> =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, budget);
    const [extent] = await tx
      .select({
        largestShard: max(caseLawSitemapShards.total),
        shards: sql<number>`count(*)::int`,
      })
      .from(caseLawSitemapShards)
      .where(
        inArray(caseLawSitemapShards.country, [
          ...PUBLIC_CASE_LAW_PAGE_COUNTRIES,
        ]),
      );
    return {
      largestShard: extent?.largestShard ?? 0,
      shards: extent?.shards ?? 0,
    };
  });

/**
 * How long one run recounts before it stops at the next month boundary. It
 * leaves the scheduler's runtime ceiling room for the month in progress; the
 * next run continues from the rows still logged.
 */
const SITEMAP_REFRESH_RUN_BUDGET_MS = 15 * 60 * 1000;

type SitemapRefreshOutcome =
  | { type: "pending"; months: number }
  | {
      type: "refreshed";
      months: number;
      largestShard: number;
      shards: number;
    };

/**
 * Bring the public sitemap shards up to date with the months the change log
 * names.
 *
 * Each logged month is recounted on its own, a short read-only transaction
 * for the count and a short fenced write for its rows, so no statement or
 * transaction grows with the corpus and no lock is held across months. A
 * whole-country row is first expanded into one logged row per month (and an
 * every-country row into one whole-country row per country), so later runs
 * recount them and drop the rows of months the country no longer holds. A
 * run works oldest log row first, works a month at most once, and stops
 * between units once its budget is spent, or after an expansion (`pending`);
 * the next run continues from the rows still logged.
 *
 * The index read refuses a snapshot it cannot serve, so an over-capacity
 * index is logged here rather than withheld.
 */
export const refreshCaseLawSitemapShards = async (
  db: RefreshDb,
  {
    poolIdleTimeoutS = envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
    runBudgetMs = SITEMAP_REFRESH_RUN_BUDGET_MS,
    clock = () => performance.now(),
    signal,
  }: {
    /** The idle timeout of the pool `db` draws from; see `sitemapRefreshBudget`. */
    poolIdleTimeoutS?: number;
    runBudgetMs?: number;
    /** Monotonic milliseconds; only differences are read. */
    clock?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<SitemapRefreshOutcome> => {
  const startedAt = clock();
  const budget = sitemapRefreshBudget(poolIdleTimeoutS);
  throwIfAborted(signal);
  const run: RunContext = {
    db,
    budget,
    horizon: await readHorizon(db, budget),
    signal,
  };
  // Logged months worked in this run. Working one consumes every row of it
  // the run may consume (or leaves them to a newer count that fenced it
  // out), so a later read in this run lists it again only in that case.
  const worked = new Set<string>();
  let units = 0;
  let months = 0;
  // Expanded rows are this run's own writes, worked by the next run.
  let expanded = false;
  const queue: SitemapMonth[] = [];

  /** One step of the run: list more logged months, or work the next one. */
  const advance = async (): Promise<"progress" | "pending" | "done"> => {
    const target = queue.shift();
    if (target === undefined) {
      const pending = (await readPendingMonths(run)).filter(
        (logged) => !worked.has(monthKey(logged)),
      );
      queue.push(...pending);
      return pending.length === 0 ? "done" : "progress";
    }
    if (worked.has(monthKey(target))) {
      return "progress";
    }
    throwIfAborted(signal);
    // Checked before every unit but the first, so every run advances.
    if (units > 0 && clock() - startedAt >= runBudgetMs) {
      return "pending";
    }
    units += 1;
    worked.add(monthKey(target));
    if (target.country === SITEMAP_WHOLE_COUNTRY) {
      await expandEveryCountry(run);
      expanded = true;
    } else if (target.year === SITEMAP_WHOLE_COUNTRY) {
      await expandCountry(run, target.country);
      expanded = true;
    } else if (await recountMonth(run, target)) {
      months += 1;
    }
    return "progress";
  };

  for (;;) {
    // db-await-in-loop: logged months are worked oldest first, one short transaction pair at a time, so the run can stop between any two
    const step = await advance();
    if (step === "pending") {
      return { type: "pending", months };
    }
    if (step === "done") {
      break;
    }
  }
  if (expanded) {
    return { type: "pending", months };
  }

  const extent = await readPublicShardExtent(db, budget);
  if (
    extent.largestShard > LIMITS.caseLawSitemapShardUrlLimit ||
    extent.shards > LIMITS.caseLawSitemapIndexEntryLimit - 1
  ) {
    logger.error("case_law.sitemap.shard_refresh_over_capacity", extent);
  }
  return { type: "refreshed", months, ...extent };
};
