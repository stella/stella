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
import {
  tryLockCaseLawSitemapMonth,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readCursorPage } from "@/api/lib/db/read-bounded";
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

/** Logged months read per page; the run reads the next page once they are done. */
const PENDING_MONTHS_PAGE_SIZE = 500;

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
 * The bounds are built by the database from the validated path text.
 */
const monthRangeSql = ({ year, month }: SitemapMonth): SQL => {
  if (year === SITEMAP_UNDATED_YEAR && month === SITEMAP_UNDATED_MONTH) {
    return sql`${caseLawDecisions.decisionDate} IS NULL`;
  }
  if (!DATED_YEAR.test(year) || !DATED_MONTH.test(month)) {
    return panic(`Malformed sitemap month ${year}/${month}`);
  }
  const start = `${year}-${month}-01`;
  return sql`${caseLawDecisions.decisionDate} >= ${start}::date AND ${caseLawDecisions.decisionDate} < (${start}::date + interval '1 month')::date`;
};

/**
 * One month's published decisions among the redistributable sources, counted
 * per bucket with their newest `updated_at`, together with the ids of the
 * month's change-log rows read from the same snapshot. A log row visible to
 * that snapshot was written by a transaction that committed before it, so
 * its change is in the count; one committed later is not listed and stays
 * logged. An empty month answers one row with its log ids and no bucket.
 *
 * The country and the month's date range are the leading keys of
 * `case_law_decisions_sitemap_shard_published_idx` and the publication gate is
 * its partial predicate, so the count reads that month's index range and
 * nothing else. Exported for the plan contract.
 */
export const sitemapMonthCountSql = (target: SitemapMonth): SQL => sql`
  WITH logged AS (
    SELECT string_agg(${caseLawSitemapChanges.id}::text, ',') AS consumed
    FROM ${caseLawSitemapChanges}
    WHERE ${caseLawSitemapChanges.country} = ${target.country}
      AND ${caseLawSitemapChanges.year} = ${target.year}
      AND ${caseLawSitemapChanges.month} = ${target.month}
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
  SELECT logged.consumed, counts.bucket, counts.total, counts.last_modified_ms
  FROM logged
  LEFT JOIN counts ON true
`;

/**
 * The months a country holds published decisions in: a loose index scan
 * that jumps from each month's first decision to the first one at or after
 * the next month's start, one descent per month, plus one probe for the
 * undated decisions.
 */
const sitemapCountryMonthsSql = (country: string): SQL => sql`
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

const LOG_IDS = /^[0-9]+(?:,[0-9]+)*$/u;

const monthCountRowSchema = v.union([
  v.object({
    consumed: v.nullable(v.pipe(v.string(), v.regex(LOG_IDS))),
    bucket: v.string(),
    total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    last_modified_ms: v.number(),
  }),
  v.object({
    consumed: v.nullable(v.pipe(v.string(), v.regex(LOG_IDS))),
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

const loggedRowsOf = (target: SitemapMonth): SQL =>
  and(
    eq(caseLawSitemapChanges.country, target.country),
    eq(caseLawSitemapChanges.year, target.year),
    eq(caseLawSitemapChanges.month, target.month),
  ) ?? panic("A logged month has conditions");

type RunContext = {
  db: RefreshDb;
  budget: SitemapRefreshBudget;
  signal: AbortSignal | undefined;
};

/**
 * Recount one month and replace its shard rows, in one short transaction
 * that holds the month from its count to its write.
 *
 * The count statement also lists the month's log rows its own snapshot sees,
 * and the write deletes exactly those, so a change is consumed only by a
 * count that includes it, whatever else is running in the database. Holding
 * the month keeps overlapping refreshes from interleaving on it: one that
 * finds the month held skips it, since the holder's count is at least as new
 * as one it could take, and a change the holder does not see stays logged.
 * Answers whether the month was written.
 */
const recountMonth = async (
  { db, budget, signal }: RunContext,
  target: SitemapMonth,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    if (!(await tryLockCaseLawSitemapMonth({ tx, month: target }))) {
      return false;
    }
    const counted = executedRows(
      await tx.execute(sitemapMonthCountSql(target)),
    ).map((row) => v.parse(monthCountRowSchema, row));
    const consumed = counted.at(0)?.consumed ?? null;
    const buckets = counted.flatMap((row) =>
      row.bucket === null ? [] : [row],
    );
    const rows = shardRows(target, buckets);
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
    if (consumed !== null) {
      await tx
        .delete(caseLawSitemapChanges)
        .where(
          sql`${caseLawSitemapChanges.id} = ANY(string_to_array(${consumed}, ',')::bigint[])`,
        );
    }
    // A run whose lease was lost while it wrote rolls back here.
    throwIfAborted(signal);
    return true;
  });

const wholeCountryRow = (country: string): SitemapMonth => ({
  country,
  year: SITEMAP_WHOLE_COUNTRY,
  month: SITEMAP_WHOLE_COUNTRY,
});

/** The ids of a target's log rows, read before the enumeration that answers them. */
const readLoggedIds = async (
  tx: RefreshTransaction,
  target: SitemapMonth,
): Promise<number[]> =>
  (
    await tx
      .select({ id: caseLawSitemapChanges.id })
      .from(caseLawSitemapChanges)
      .where(loggedRowsOf(target))
  ).map(({ id }) => id);

const deleteLoggedIds = async (
  tx: RefreshTransaction,
  ids: readonly number[],
): Promise<void> => {
  if (ids.length > 0) {
    await tx
      .delete(caseLawSitemapChanges)
      .where(inArray(caseLawSitemapChanges.id, [...ids]));
  }
};

/**
 * Turn a whole-country row into one log row per month its recount covers, in
 * one short write transaction that also consumes the whole-country rows it
 * read first: the months the country holds published decisions in, and the
 * months its shards list (an emptied month is recounted to no rows). The new
 * rows are recounted month by month like any other, so a country larger than
 * one run's budget keeps its progress between runs.
 */
const expandCountry = async (
  { db, budget, signal }: RunContext,
  country: string,
): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    const whole = await readLoggedIds(tx, wholeCountryRow(country));
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
    await deleteLoggedIds(tx, whole);
    throwIfAborted(signal);
  });
};

/**
 * Turn an every-country row into one whole-country row per country, in one
 * short write transaction that also consumes the every-country rows it read
 * first: the countries holding a published decision and those the shards
 * list (a country with no decision left is recounted to no rows).
 */
const expandEveryCountry = async ({
  db,
  budget,
  signal,
}: RunContext): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    const every = await readLoggedIds(
      tx,
      wholeCountryRow(SITEMAP_WHOLE_COUNTRY),
    );
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
    await deleteLoggedIds(tx, every);
    throwIfAborted(signal);
  });
};

/** The next page of logged months, oldest log row first. */
const readPendingMonths = async ({
  db,
  budget,
}: RunContext): Promise<SitemapMonth[]> =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await setTransactionBudget(tx, budget);
    const firstId = sql<number>`min(${caseLawSitemapChanges.id})`;
    const page = await readCursorPage(
      tx
        .select({
          country: caseLawSitemapChanges.country,
          year: caseLawSitemapChanges.year,
          month: caseLawSitemapChanges.month,
        })
        .from(caseLawSitemapChanges)
        .groupBy(
          caseLawSitemapChanges.country,
          caseLawSitemapChanges.year,
          caseLawSitemapChanges.month,
        )
        .orderBy(asc(firstId)),
      { limit: PENDING_MONTHS_PAGE_SIZE, cursorForItem: monthKey },
    );
    return page.items;
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

/** What a run has worked so far. */
type RunProgress = {
  /** Logged months and whole-country rows worked in this run. */
  worked: Set<string>;
  /** Units of work done: a month recounted, skipped or a row expanded. */
  units: number;
  /** Months recounted and written. */
  months: number;
};

/**
 * Bring the public sitemap shards up to date with the months the change log
 * names.
 *
 * Each logged month is recounted on its own short transaction, so no
 * statement or transaction grows with the corpus and no lock is held across
 * months. A whole-country row is first expanded into one logged row per
 * month (and an every-country row into one whole-country row per country),
 * which are then recounted like any other and drop the rows of months the
 * country no longer holds. A run works oldest log row first, works a month
 * at most once, and stops between units once its budget is spent
 * (`pending`); the next run continues from the rows still logged.
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
  const run: RunContext = { db, budget, signal };
  // A month worked in this run is not worked again in it: changes committed
  // to it meanwhile wait for the next run, so a month written to without
  // pause cannot keep one run going.
  const progress: RunProgress = { worked: new Set(), units: 0, months: 0 };
  const queue: SitemapMonth[] = [];

  /** One step of the run: list more logged months, or work the next one. */
  const advance = async (): Promise<"progress" | "pending" | "done"> => {
    const target = queue.shift();
    if (target === undefined) {
      const pending = (await readPendingMonths(run)).filter(
        (logged) => !progress.worked.has(monthKey(logged)),
      );
      queue.push(...pending);
      return pending.length === 0 ? "done" : "progress";
    }
    if (progress.worked.has(monthKey(target))) {
      return "progress";
    }
    throwIfAborted(signal);
    // Checked before every unit but the first, so every run advances.
    if (progress.units > 0 && clock() - startedAt >= runBudgetMs) {
      return "pending";
    }
    progress.units += 1;
    progress.worked.add(monthKey(target));
    if (target.country === SITEMAP_WHOLE_COUNTRY) {
      await expandEveryCountry(run);
    } else if (target.year === SITEMAP_WHOLE_COUNTRY) {
      await expandCountry(run, target.country);
    } else if (await recountMonth(run, target)) {
      progress.months += 1;
    }
    return "progress";
  };

  for (;;) {
    // db-await-in-loop: logged months are worked oldest first, one short transaction at a time, so the run can stop between any two
    const step = await advance();
    if (step === "pending") {
      return { type: "pending", months: progress.months };
    }
    if (step === "done") {
      break;
    }
  }

  const extent = await readPublicShardExtent(db, budget);
  if (
    extent.largestShard > LIMITS.caseLawSitemapShardUrlLimit ||
    extent.shards > LIMITS.caseLawSitemapIndexEntryLimit - 1
  ) {
    logger.error("case_law.sitemap.shard_refresh_over_capacity", extent);
  }
  return { type: "refreshed", months: progress.months, ...extent };
};
