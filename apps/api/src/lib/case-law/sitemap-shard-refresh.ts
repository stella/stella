import { panic } from "better-result";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { compareCodeUnit } from "@stll/collation";

import type { rootDb } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapCountryGenerations,
  caseLawSitemapDrainProgress,
  caseLawSitemapRefreshCursor,
  caseLawSitemapShardCounts,
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
import { SITEMAP_DRAIN_TRANSITIONS } from "@/api/lib/case-law/sitemap-drain-transitions";
import {
  decisionBucketSqlFor,
  SITEMAP_ALL_BUCKET,
  SITEMAP_MULTILINGUAL_URL_WEIGHT,
  SITEMAP_UNDATED_MONTH,
  SITEMAP_UNDATED_YEAR,
  sitemapDocumentRepresentativeFor,
  sitemapHasLanguageAlternatesFor,
} from "@/api/lib/case-law/sitemap-shard-sql";
import {
  lockCaseLawRemovalSnapshots,
  lockCaseLawSitemapRefreshCursor,
  tryLockCaseLawSitemapMonth,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { READ_BUDGETS } from "@/api/lib/db/read-budgets";
import { transitionScopedBatch } from "@/api/lib/db/transitions";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/** Growth between refreshes must not consume the protocol ceiling. */
export const SITEMAP_SHARD_URL_HEADROOM = 1000;
/** Language alternates reserve extra URL weight within the protocol ceiling. */
export const SITEMAP_SHARD_SPLIT_THRESHOLD =
  LIMITS.caseLawSitemapShardUrlLimit - SITEMAP_SHARD_URL_HEADROOM;

export const shouldSplitSitemapMonth = (weightedUrlCount: number): boolean =>
  weightedUrlCount > SITEMAP_SHARD_SPLIT_THRESHOLD;

/**
 * A change-log row whose year and month are this asks for a whole country,
 * and one whose country is this asks for every country.
 */
export const SITEMAP_WHOLE_COUNTRY = "*";

/** Discovery rows and retirement candidates allowed across one tick. */
const DEFAULT_CHANGE_ROW_BUDGET = 500;
const MAX_CHANGE_ROWS_PER_RUN = 10_000;
const DEFAULT_DISCOVERY_TARGET_BUDGET = 64;
const MAX_DISCOVERY_TARGETS_PER_RUN = 256;

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
const MAX_STATEMENT_TIMEOUT_MS =
  READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"].statementDeadlineMs;
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
 * per bucket with their newest `updated_at`. Retirement uses the durable
 * transaction boundary captured before this count; later commits stay queued.
 * An empty month answers one row with no bucket.
 *
 * The country and the month's date range are the leading keys of
 * `case_law_decisions_sitemap_shard_published_idx` and the publication gate is
 * its partial predicate, so the count reads that month's index range and
 * nothing else. Exported for the plan contract.
 */
export const sitemapMonthCountSql = (target: SitemapMonth): SQL => sql`
  WITH counts AS (
    SELECT
      ${decisionBucketSqlFor(caseLawDecisions)} AS bucket,
      count(*)::int AS total,
      sum(CASE WHEN ${sitemapHasLanguageAlternatesFor(caseLawDecisions)}
        THEN ${SITEMAP_MULTILINGUAL_URL_WEIGHT} ELSE 1 END)::int AS weighted_total,
      (extract(epoch FROM max(${caseLawDecisions.updatedAt})) * 1000)::float8 AS last_modified_ms
    FROM ${caseLawDecisions}
    INNER JOIN ${caseLawSources} ON ${caseLawSources.id} = ${caseLawDecisions.sourceId}
    WHERE ${publishedCaseLawDecisionFor(caseLawDecisions)}
      AND ${caseLawDecisions.country} = ${target.country}
      AND ${monthRangeSql(target)}
      AND ${redistributableCaseLawSource}
      AND ${sitemapDocumentRepresentativeFor(caseLawDecisions)}
    GROUP BY 1
  )
  SELECT counts.bucket, counts.total, counts.weighted_total, counts.last_modified_ms
  FROM (VALUES (1)) AS empty_month(value)
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

const monthCountRowSchema = v.union([
  v.object({
    bucket: v.string(),
    total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    weighted_total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    last_modified_ms: v.number(),
  }),
  v.object({
    bucket: v.null(),
    total: v.null(),
    weighted_total: v.null(),
    last_modified_ms: v.null(),
  }),
]);
type BucketCount = {
  bucket: string;
  total: number;
  weighted_total: number;
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
  let monthWeightedTotal = 0;
  let monthLastModifiedMs = 0;
  for (const { total, weighted_total, last_modified_ms } of buckets) {
    monthTotal += total;
    monthWeightedTotal += weighted_total;
    monthLastModifiedMs = Math.max(monthLastModifiedMs, last_modified_ms);
  }
  if (monthTotal === 0) {
    return [];
  }
  const { country, year, month } = target;
  if (shouldSplitSitemapMonth(monthWeightedTotal)) {
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

const targetConditions = (target: SitemapMonth) =>
  and(
    eq(caseLawSitemapDrainProgress.country, target.country),
    eq(caseLawSitemapDrainProgress.year, target.year),
    eq(caseLawSitemapDrainProgress.month, target.month),
  );

/** A tick accounts for discovery rows and retirement candidates together. */
type SitemapChangeBudget = { remainingRows: number };
type SitemapDiscoveryBudget = { remainingTargets: number };

type RunContext = {
  db: RefreshDb;
  budget: SitemapRefreshBudget;
  signal: AbortSignal | undefined;
};

/** Recount and publish while the caller holds the month and removal fence. */
const recountMonth = async (
  tx: RefreshTransaction,
  target: SitemapMonth,
): Promise<void> => {
  const counted = executedRows(
    await tx.execute(sitemapMonthCountSql(target)),
  ).map((row) => v.parse(monthCountRowSchema, row));
  const buckets = counted.flatMap((row) => (row.bucket === null ? [] : [row]));
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
};

const wholeCountryRow = (country: string): SitemapMonth => ({
  country,
  year: SITEMAP_WHOLE_COUNTRY,
  month: SITEMAP_WHOLE_COUNTRY,
});

/**
 * Turn a whole-country row into one log row per month its recount covers, in
 * the same transaction as its durable retirement boundary: the months the
 * country holds published decisions in, and the
 * months its shards list (an emptied month is recounted to no rows). The new
 * rows are recounted month by month like any other, so a country larger than
 * one run's budget keeps its progress between runs.
 */
const expandCountry = async (
  tx: RefreshTransaction,
  country: string,
): Promise<void> => {
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
};

/**
 * Turn an every-country row into one whole-country row per country, in one
 * transaction as its durable retirement boundary: the countries holding a
 * published decision and those the shards
 * list (a country with no decision left is recounted to no rows).
 */
const expandEveryCountry = async (tx: RefreshTransaction): Promise<void> => {
  const held = executedRows(await tx.execute(sitemapCountriesSql())).map(
    (row) => v.parse(v.object({ country: v.string() }), row).country,
  );
  const listed = await tx
    .selectDistinct({ country: caseLawSitemapShards.country })
    .from(caseLawSitemapShards);
  const countries = new Set([...held, ...listed.map(({ country }) => country)]);
  if (countries.size > 0) {
    await tx
      .insert(caseLawSitemapChanges)
      .values([...countries].toSorted(compareCodeUnit).map(wholeCountryRow));
  }
};

const SITEMAP_DISCOVERY_START = { country: "", year: "", month: "" };

/** Each source contributes at most one indexed target, even behind a hot month. */
export const sitemapPendingMonthsSql = (
  after: SitemapMonth = SITEMAP_DISCOVERY_START,
): SQL => sql`
  WITH next_change AS MATERIALIZED (
    SELECT country, year, month FROM ${caseLawSitemapChanges}
    WHERE (country, year, month) > (${after.country}::text, ${after.year}::text, ${after.month}::text)
    ORDER BY country, year, month LIMIT 1
  ), next_progress AS MATERIALIZED (
    SELECT country, year, month FROM ${caseLawSitemapDrainProgress}
    WHERE (country, year, month) > (${after.country}::text, ${after.year}::text, ${after.month}::text)
    ORDER BY country, year, month LIMIT 1
  ), following AS MATERIALIZED (
    SELECT country, year, month FROM next_change
    UNION ALL SELECT country, year, month FROM next_progress
    ORDER BY country, year, month LIMIT 1
  ), first_change AS MATERIALIZED (
    SELECT country, year, month FROM ${caseLawSitemapChanges}
    WHERE NOT EXISTS (SELECT 1 FROM following)
    ORDER BY country, year, month LIMIT 1
  ), first_progress AS MATERIALIZED (
    SELECT country, year, month FROM ${caseLawSitemapDrainProgress}
    WHERE NOT EXISTS (SELECT 1 FROM following)
    ORDER BY country, year, month LIMIT 1
  ), wrapped AS MATERIALIZED (
    SELECT country, year, month FROM first_change
    UNION ALL SELECT country, year, month FROM first_progress
    ORDER BY country, year, month LIMIT 1
  )
  SELECT selected.country, selected.year, selected.month,
    CASE WHEN EXISTS (
      SELECT 1 FROM ${caseLawSitemapDrainProgress} progress
      WHERE progress.country = selected.country AND progress.year = selected.year AND progress.month = selected.month
        AND progress.phase = 'awaiting_visibility'
        AND progress.covered_before >= pg_snapshot_xmin(pg_current_snapshot())
    ) THEN 'waiting' ELSE 'ready' END AS status,
    (SELECT count(*)::int FROM next_change) + (SELECT count(*)::int FROM first_change) AS change_rows_read
  FROM (
    SELECT country, year, month FROM following
    UNION ALL SELECT country, year, month FROM wrapped
    LIMIT 1
  ) selected
`;

type PendingMonth =
  | { status: "empty"; changeRowsRead: number }
  | { status: "waiting"; target: SitemapMonth; changeRowsRead: number }
  | { status: "ready"; target: SitemapMonth; changeRowsRead: number };

const readPendingMonth = async (
  { db, budget }: RunContext,
  cursorMode: "advance" | "observe",
): Promise<PendingMonth> =>
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    await tx
      .insert(caseLawSitemapRefreshCursor)
      .values({ slot: 0 })
      .onConflictDoNothing();
    const cursor = v.parse(
      v.object({
        last_country: v.string(),
        last_year: v.string(),
        last_month: v.string(),
      }),
      (await lockCaseLawSitemapRefreshCursor(tx)).at(0),
    );
    const row = executedRows(
      await tx.execute(
        sitemapPendingMonthsSql({
          country: cursor.last_country,
          year: cursor.last_year,
          month: cursor.last_month,
        }),
      ),
    ).at(0);
    if (row === undefined) {
      return { status: "empty", changeRowsRead: 0 };
    }
    const {
      status,
      change_rows_read: changeRowsRead,
      ...target
    } = v.parse(
      v.object({
        status: v.picklist(["ready", "waiting"]),
        country: v.string(),
        year: v.string(),
        month: v.string(),
        change_rows_read: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.maxValue(1),
        ),
      }),
      row,
    );
    // An exhausted time budget may check for completion without skipping work.
    if (cursorMode === "advance") {
      // Commit the next position before taking a month lock or doing a recount.
      await tx
        .update(caseLawSitemapRefreshCursor)
        .set({
          lastCountry: target.country,
          lastYear: target.year,
          lastMonth: target.month,
        })
        .where(eq(caseLawSitemapRefreshCursor.slot, 0));
    }
    if (status === "waiting") {
      return { status, target, changeRowsRead };
    }
    return { status, target, changeRowsRead };
  });

/**
 * Every visible log row older than the snapshot's xmin committed before it.
 * The month/xact index bounds this range even when newer changes keep arriving.
 * IDs cannot supply this boundary: a smaller ID may commit after the count.
 * Inside the covered range every transaction has finished, so advancing the
 * retirement cursor cannot skip a late commit and avoids rescanning dead entries.
 */
type DrainMonthResult =
  | { status: "held" | "waiting" }
  | {
      status: "complete" | "draining";
      candidatesRead: number;
      recounted: boolean;
    };

const drainMonth = async (
  { db, budget, signal }: RunContext,
  target: SitemapMonth,
  rows: number,
): Promise<DrainMonthResult> =>
  await withAggregateTransaction(db, async (tx) => {
    await setTransactionBudget(tx, budget);
    if (!(await tryLockCaseLawSitemapMonth({ tx, month: target }))) {
      return { status: "held" };
    }
    await lockCaseLawRemovalSnapshots(tx);
    const [progress] = await tx
      .select()
      .from(caseLawSitemapDrainProgress)
      .where(targetConditions(target))
      .limit(1);
    let coveredBefore = progress?.coveredBefore;
    let retiredThrough = progress?.retiredThrough ?? "0";
    let recounted = false;
    if (
      coveredBefore === undefined ||
      progress?.phase === "awaiting_visibility"
    ) {
      // Capture before counting/enumerating; every earlier transaction is in
      // every subsequent READ COMMITTED snapshot used to publish this work.
      const snapshot = executedRows(
        await tx.execute(sql`
        SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS covered_before
      `),
      ).at(0);
      const nextBoundary = v.parse(
        v.object({ covered_before: v.string() }),
        snapshot,
      ).covered_before;
      if (
        coveredBefore !== undefined &&
        BigInt(nextBoundary) <= BigInt(coveredBefore)
      ) {
        return { status: "waiting" };
      }
      coveredBefore = nextBoundary;
      if (target.country === SITEMAP_WHOLE_COUNTRY) {
        await expandEveryCountry(tx);
      } else if (target.year === SITEMAP_WHOLE_COUNTRY) {
        await expandCountry(tx, target.country);
      } else {
        await recountMonth(tx, target);
        recounted = true;
      }
      if (progress === undefined) {
        await tx
          .insert(caseLawSitemapDrainProgress)
          .values({ ...target, coveredBefore });
      } else {
        const changed = await transitionScopedBatch({
          tx,
          spec: SITEMAP_DRAIN_TRANSITIONS,
          identities: [target],
          options: {
            from: ["awaiting_visibility"],
            to: "draining",
            set: { coveredBefore, retiredThrough },
          },
          recordTransitionAuditEvent: () => undefined,
        });
        if (changed.length !== 1) {
          panic("Locked sitemap coverage must resume from its waiting phase");
        }
      }
    }
    const retirement = v.parse(
      v.object({
        candidates_read: v.number(),
        retired: v.number(),
        retired_through: v.nullable(v.string()),
      }),
      executedRows(
        await tx.execute(sql`
        WITH RECURSIVE candidates AS (
          (
            SELECT id, xact, 1 AS step FROM ${caseLawSitemapChanges}
            WHERE country = ${target.country} AND year = ${target.year} AND month = ${target.month}
              AND xact > ${retiredThrough}::xid8
            ORDER BY country, year, month, xact
            LIMIT 1
          )
          UNION ALL
          SELECT next.id, next.xact, candidates.step + 1
          FROM candidates
          CROSS JOIN LATERAL (
            SELECT id, xact FROM ${caseLawSitemapChanges}
            WHERE country = ${target.country} AND year = ${target.year} AND month = ${target.month}
              AND xact > candidates.xact
            ORDER BY country, year, month, xact
            LIMIT 1
          ) AS next
          WHERE candidates.step < ${rows} AND candidates.xact < ${coveredBefore}::xid8
        ), retired AS (
          DELETE FROM ${caseLawSitemapChanges} AS changes
          WHERE changes.id = ANY(ARRAY(
            SELECT id FROM candidates WHERE xact < ${coveredBefore}::xid8
          ))
          RETURNING changes.xact
        )
        SELECT (SELECT count(*)::int FROM candidates) AS candidates_read,
          count(*)::int AS retired, max(xact)::text AS retired_through FROM retired
      `),
      ).at(0),
    );
    // One ordered probe per candidate remains cheap even with stale statistics.
    // Stop at the first uncovered transaction and charge it to the allowance.
    // The materialized ID array also bounds the DELETE probes.
    const candidatesRead = retirement.candidates_read;
    const complete =
      candidatesRead < rows || retirement.retired < candidatesRead;
    if (retirement.retired_through !== null) {
      retiredThrough = retirement.retired_through;
    }
    if (retirement.retired < candidatesRead) {
      const changed = await transitionScopedBatch({
        tx,
        spec: SITEMAP_DRAIN_TRANSITIONS,
        identities: [target],
        options: {
          from: ["draining"],
          to: "awaiting_visibility",
          set: { retiredThrough },
        },
        recordTransitionAuditEvent: () => undefined,
      });
      if (changed.length !== 1) {
        panic("Locked sitemap coverage must wait from its draining phase");
      }
    } else if (complete) {
      await tx
        .delete(caseLawSitemapDrainProgress)
        .where(targetConditions(target));
    } else {
      await tx
        .update(caseLawSitemapDrainProgress)
        .set({ retiredThrough })
        .where(targetConditions(target));
    }
    throwIfAborted(signal);
    return {
      status: complete ? "complete" : "draining",
      candidatesRead,
      recounted,
    };
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
const SITEMAP_REFRESH_RUN_BUDGET_MS =
  READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"].runBudgetMs;

type SitemapRefreshOutcome =
  | { type: "pending"; months: number; retry: "immediate" | "delayed" }
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
  /** Broad invalidations must not consume changes after these counts. */
  recountedCountries: Set<string>;
};

/**
 * Bring the public sitemap shards up to date with the months the change log
 * names.
 *
 * Each logged month is recounted on its own short transaction, so no
 * change-log read or deletion grows with the backlog; no lock is held across
 * months. Completed recounts persist their snapshot xmin, so later ticks
 * retire covered transactions without repeating the count. A whole-country
 * row is first expanded into one logged row per month (and an every-country row into one whole-country row per country),
 * which are then recounted like any other and drop the rows of months the
 * country no longer holds. Discovery rotates durably over distinct month keys
 * in the log and progress indexes, skipping held or visibility-stalled work.
 * A run works a month at most once and stops when its row, target, or time budget is spent
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
    changeRowBudget = DEFAULT_CHANGE_ROW_BUDGET,
    discoveryTargetBudget = DEFAULT_DISCOVERY_TARGET_BUDGET,
    clock = () => performance.now(),
    signal,
  }: {
    /** The idle timeout of the pool `db` draws from; see `sitemapRefreshBudget`. */
    poolIdleTimeoutS?: number;
    runBudgetMs?: number;
    /** Discovery rows plus retirement candidates, across the entire tick. */
    changeRowBudget?: number;
    /** Target attempts, including waiting, held, and progress-only targets. */
    discoveryTargetBudget?: number;
    /** Monotonic milliseconds; only differences are read. */
    clock?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<SitemapRefreshOutcome> => {
  if (
    !Number.isSafeInteger(changeRowBudget) ||
    changeRowBudget < 2 ||
    changeRowBudget > MAX_CHANGE_ROWS_PER_RUN
  ) {
    return panic(
      `Sitemap change-row budget must be between 2 and ${MAX_CHANGE_ROWS_PER_RUN}`,
    );
  }
  if (
    !Number.isSafeInteger(discoveryTargetBudget) ||
    discoveryTargetBudget < 1 ||
    discoveryTargetBudget > MAX_DISCOVERY_TARGETS_PER_RUN
  ) {
    return panic(
      `Sitemap discovery target budget must be between 1 and ${MAX_DISCOVERY_TARGETS_PER_RUN}`,
    );
  }
  const startedAt = clock();
  const budget = sitemapRefreshBudget(poolIdleTimeoutS);
  throwIfAborted(signal);
  const run: RunContext = { db, budget, signal };
  // A month worked in this run is not worked again in it: changes committed
  // to it meanwhile wait for the next run, so a month written to without
  // pause cannot keep one run going.
  const progress: RunProgress = {
    worked: new Set(),
    units: 0,
    months: 0,
    recountedCountries: new Set(),
  };
  const changeBudget: SitemapChangeBudget = { remainingRows: changeRowBudget };
  const discoveryBudget: SitemapDiscoveryBudget = {
    remainingTargets: discoveryTargetBudget,
  };
  const attempted = new Set<string>();
  const pendingOutcome = (
    retry: "immediate" | "delayed",
  ): SitemapRefreshOutcome => ({
    type: "pending",
    months: progress.months,
    retry,
  });
  const advance = async (): Promise<
    "progress" | "immediate" | "delayed" | "done"
  > => {
    if (
      changeBudget.remainingRows < 2 ||
      discoveryBudget.remainingTargets === 0
    ) {
      return "immediate";
    }
    const cursorMode =
      progress.units > 0 && clock() - startedAt >= runBudgetMs
        ? "observe"
        : "advance";
    const pending = await readPendingMonth(run, cursorMode);
    if (pending.status === "empty") {
      return "done";
    }
    const { target } = pending;
    discoveryBudget.remainingTargets -= 1;
    changeBudget.remainingRows -= pending.changeRowsRead;
    if (cursorMode === "observe") {
      return "immediate";
    }
    const key = monthKey(target);
    // Seeing a target twice completes one local rotation, rather than spinning.
    if (attempted.has(key)) {
      return "delayed";
    }
    attempted.add(key);
    progress.units += 1;
    if (pending.status === "waiting" || progress.worked.has(key)) {
      return "progress";
    }
    if (
      target.year === SITEMAP_WHOLE_COUNTRY &&
      (target.country === SITEMAP_WHOLE_COUNTRY
        ? progress.recountedCountries.size > 0
        : progress.recountedCountries.has(target.country))
    ) {
      return "progress";
    }
    throwIfAborted(signal);
    const step = await drainMonth(run, target, changeBudget.remainingRows);
    switch (step.status) {
      case "waiting":
      case "held":
        return "progress";
      case "complete":
      case "draining":
        changeBudget.remainingRows -= step.candidatesRead;
        if (step.recounted) {
          progress.months += 1;
          progress.recountedCountries.add(target.country);
        }
        progress.worked.add(key);
        return "progress";
      default: {
        step satisfies never;
        return panic("Unknown sitemap drain result");
      }
    }
  };

  for (;;) {
    // db-await-in-loop: consecutive durable drain steps share one tick row budget and stop between month transactions
    const step = await advance();
    if (step === "done") {
      break;
    }
    if (step !== "progress") {
      return pendingOutcome(step);
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

/** Retire both staged counts and published shards for the changed country. */
export const invalidateCaseLawSitemapShardsTx = async (
  tx: RefreshTransaction,
  country: string,
): Promise<void> => {
  await tx
    .insert(caseLawSitemapCountryGenerations)
    .values({ country, generation: 1n })
    .onConflictDoUpdate({
      target: caseLawSitemapCountryGenerations.country,
      set: {
        generation: sql`${caseLawSitemapCountryGenerations.generation} + 1`,
      },
    });
  // audit: skip — sitemap invalidation belongs to the canonical removal audit.
  await tx
    .delete(caseLawSitemapShardCounts)
    .where(eq(caseLawSitemapShardCounts.country, country));
  await tx
    .delete(caseLawSitemapShards)
    .where(eq(caseLawSitemapShards.country, country));
};
