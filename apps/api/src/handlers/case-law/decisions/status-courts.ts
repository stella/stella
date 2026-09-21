import { sql } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { courtAbbreviation } from "@/api/lib/case-law/court-abbreviations";
import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@/api/lib/case-law/court-tiers";
import {
  courtTierLabelFromMap,
  type CourtWeightMap,
} from "@/api/lib/case-law/court-weights";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";
import type { FacetBucket } from "@/api/lib/search/types";

/**
 * The corpus status broken down by court: which courts a jurisdiction's public
 * case law comes from, how much of each the corpus holds, what arrived
 * recently, and when each last changed.
 *
 * Built from the browse facets the status already reads, so the courts are the
 * jurisdiction's largest and their counts are the counts the search itself
 * reports. The activity beside each comes from one bounded read per court.
 *
 * The two answer different questions from different places on purpose, the
 * way the status's own count and timestamp already do. `decisions` is what a
 * search can find: the serving projection's bucket, which omits a decision
 * with no canonical payload and trails ingestion by a projection lag. The
 * `added` windows are what ingestion wrote, straight from the decisions
 * table, because "did anything arrive" is a fact about ingestion and the
 * index cannot answer it — it indexes the decision's own date, not the
 * instant the row was written.
 *
 * So a delta is not a subset of the count beside it, and during a lag it can
 * exceed one. That is the honest reading of a court whose new decisions have
 * landed but are not yet searchable; the alternative is a breakdown that goes
 * quiet exactly when something is happening. The field names say which is
 * which, and nothing sums the two.
 */

/**
 * How far back "recently" reaches, in both windows the breakdown reports.
 * Plain 24-hour durations, not calendar days: the windows say how much
 * arrived in the last day and the last week, not which calendar days those
 * were, so a DST boundary must not lengthen or shorten them.
 */
const WEEK_IN_MS = 7 * DAY_IN_MS;

/**
 * Slack the window scan allows for a row whose `created_at` runs ahead of its
 * `updated_at`.
 *
 * `created_at` defaults to `clock_timestamp()` and `updated_at` to `now()`, so
 * a row inserted by a long transaction is stamped as created after it was last
 * updated, by at most that transaction's duration. The scan is an
 * `updated_at` range (that is the index it rides), so it widens by this much
 * to stay a superset of the rows the `created_at` filter then counts. An
 * insert transaction outrunning it would under-report a delta, never
 * over-report one.
 */
const CLOCK_SKEW_MARGIN_MS = DAY_IN_MS / 24;

/**
 * How long the breakdown's own statement may run.
 *
 * The public read transaction's guard is 30 s, which is three times the
 * reader's critical-query timeout: without this the status response would sit
 * behind a breakdown that has already lost the page. Bounded here instead, the
 * read is cancelled in the database and the caller degrades to no breakdown
 * while the count and the timestamp beside the search box still answer.
 *
 * Warm, the whole statement is two index probes per named court and runs in
 * milliseconds. It is this far above that because a missing or cold index is
 * the case worth surviving: without
 * `case_law_decisions_country_court_updated_idx` the same read took 31 s on a
 * million-row corpus, so the bound is what turns that into a fast, visible
 * degradation rather than a stalled page.
 */
const ACTIVITY_STATEMENT_TIMEOUT = "3s";

/**
 * How many of a tier's courts the breakdown names individually before the tier
 * becomes one row. A reader scans an apex court by name; below that, the
 * jurisdiction has dozens of them and the tier is the fact.
 */
const COURTS_NAMED_PER_TIER = 3;

/** Whether a tier's courts are worth naming one by one at all. */
const TIER_ROWS = {
  constitutional: "named",
  supreme: "named",
  regional: "grouped",
  other: "grouped",
} as const satisfies Record<CourtTierLabel, "named" | "grouped">;

/** One court of the jurisdiction, or one tier's worth of them. */
export type CaseLawCourtStatusRow =
  | {
      type: "court";
      court: string;
      /** Null where nothing states one; the name carries the meaning. */
      courtAbbreviation: string | null;
      tier: CourtTierLabel;
      /** What a search can find: the serving projection's bucket. */
      decisions: number;
      /** What ingestion wrote, which `decisions` may not yet include. */
      addedLastDay: number;
      addedLastWeek: number;
      /** ISO 8601, or null for a court no admitted row is left of. */
      updatedAt: string | null;
    }
  | {
      type: "tier";
      tier: CourtTierLabel;
      /** How many courts this row stands for. */
      courts: number;
      decisions: number;
      addedLastDay: number;
      addedLastWeek: number;
      updatedAt: string | null;
    }
  | {
      /**
       * Everything the facet buckets leave out: the jurisdiction's total
       * less the courts listed. The buckets are the largest courts up to a
       * limit, and a breakdown that stopped at the limit would sum to less
       * than the total beside it with nothing to say where the rest went.
       * How many courts these are is not known, so the row names how many
       * are listed instead; it carries no activity, because none was read.
       */
      type: "unlisted";
      tier: "other";
      listed: number;
      decisions: number;
    };

/** What one court's rows say about recent ingestion and the last change. */
export type CourtActivity = {
  addedLastDay: number;
  addedLastWeek: number;
  updatedAt: string | null;
};

type CourtActivityRead = {
  country: string;
  courts: readonly string[];
  /** The sources a public surface may not count, as the other public reads exclude them. */
  excludedSourceIds: readonly SafeId<"caseLawSource">[];
  /** The instant the two windows are measured back from. */
  now: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  let rows: unknown = result;
  if (!Array.isArray(result) && isRecord(result)) {
    rows = result["rows"];
  }
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

/**
 * The transaction's current statement timeout, so the bound this read sets can
 * be handed back. Null when the setting cannot be read, which leaves the bound
 * in place for the rest of the transaction rather than guessing a value to
 * restore.
 */
const readStatementTimeout = async (
  tx: CaseLawPublicReadTransaction,
): Promise<string | null> => {
  const result: unknown = await tx.execute(
    sql`SELECT current_setting('statement_timeout') AS statement_timeout`,
  );
  const value = rowsOf(result).at(0)?.["statement_timeout"];
  return typeof value === "string" ? value : null;
};

const toCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Per-court activity, one bounded read for the whole breakdown.
 *
 * Two laterals per named court, both riding
 * `case_law_decisions_country_court_updated_idx`: the newest admitted row of
 * the court, and the rows it has been touched in since the window opened. The
 * court list is what bounds the statement — it is the browse facets' buckets,
 * so it is the jurisdiction's largest courts and never the whole registry.
 *
 * `GROUP BY court` over the jurisdiction is what this avoids, for the reason
 * `shelf-courts.ts` records: priced as a cheap index-only scan, it reads every
 * index entry of the country and falls back to the heap wherever the pages are
 * not all-visible.
 */
export const readCaseLawCourtActivityQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCourtActivity,
  async (
    tx: CaseLawPublicReadTransaction,
    { country, courts, excludedSourceIds, now }: CourtActivityRead,
  ): Promise<ReadonlyMap<string, CourtActivity>> => {
    if (courts.length === 0) {
      return new Map();
    }
    const sinceDay = new Date(now.getTime() - DAY_IN_MS);
    const sinceWeek = new Date(now.getTime() - WEEK_IN_MS);
    const scanFrom = new Date(sinceWeek.getTime() - CLOCK_SKEW_MARGIN_MS);
    // Emitted only when a source is actually withheld, so the ordinary read
    // stays on the index alone.
    const published = sql`AND ${sql.raw(publishedCaseLawDecisionSqlFor("d"))}`;
    const admitted =
      excludedSourceIds.length === 0
        ? sql``
        : sql`AND d.source_id <> ALL(
              SELECT value::uuid
              FROM jsonb_array_elements_text(${JSON.stringify([...excludedSourceIds])}::text::jsonb) AS value
            )`;

    // Transaction-local, and restored below rather than left for whatever the
    // caller runs next: `readCaseLawCourtActivityQuery` is handed a
    // transaction, not a connection, and it is not the only read that may use
    // it. `set_config(..., true)` reverts with the transaction, so a cancelled
    // statement needs no unwinding of its own.
    const previousTimeout = await readStatementTimeout(tx);
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${ACTIVITY_STATEMENT_TIMEOUT}, true)`,
    );

    const result: unknown = await tx.execute(sql`
      SELECT
        named.court AS court,
        to_json(latest.updated_at) #>> '{}' AS updated_at,
        coalesce(recent.added_last_day, 0) AS added_last_day,
        coalesce(recent.added_last_week, 0) AS added_last_week
      FROM jsonb_array_elements_text(${JSON.stringify([...courts])}::text::jsonb)
        WITH ORDINALITY AS named(court, ordinality)
      LEFT JOIN LATERAL (
        SELECT d.updated_at
        FROM case_law_decisions d
        WHERE d.country = ${country}
          AND d.court = named.court
          ${published}
          ${admitted}
        ORDER BY d.updated_at DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE d.created_at >= ${sinceDay}::timestamptz) AS added_last_day,
          count(*) FILTER (WHERE d.created_at >= ${sinceWeek}::timestamptz) AS added_last_week
        FROM case_law_decisions d
        WHERE d.country = ${country}
          AND d.court = named.court
          AND d.updated_at >= ${scanFrom}::timestamptz
          ${published}
          ${admitted}
      ) recent ON true
      ORDER BY named.ordinality
    `);
    if (previousTimeout !== null) {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${previousTimeout}, true)`,
      );
    }

    return new Map(
      rowsOf(result).flatMap((row) => {
        const court = row["court"];
        if (typeof court !== "string") {
          return [];
        }
        const updatedAt = row["updated_at"];
        return [
          [
            court,
            {
              addedLastDay: toCount(row["added_last_day"]),
              addedLastWeek: toCount(row["added_last_week"]),
              updatedAt: typeof updatedAt === "string" ? updatedAt : null,
            },
          ],
        ] as const;
      }),
    );
  },
);

/** The newer of two timestamps, either of which may be unknown. */
const laterOf = (left: string | null, right: string | null): string | null => {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Temporal.Instant.compare(
    Temporal.Instant.from(left),
    Temporal.Instant.from(right),
  ) >= 0
    ? left
    : right;
};

type CourtStatusRowsOptions = {
  /** The browse facets' court buckets: the jurisdiction's largest courts. */
  buckets: readonly FacetBucket[];
  country: string;
  courtWeights: CourtWeightMap;
  /** Per-court activity; a court the read did not answer for reports none. */
  activity: ReadonlyMap<string, CourtActivity>;
  /** The jurisdiction's whole searchable count, which the rows must sum to. */
  total: number;
};

const NO_ACTIVITY: CourtActivity = {
  addedLastDay: 0,
  addedLastWeek: 0,
  updatedAt: null,
};

/**
 * The breakdown as the popover reads it: tiers apex first, each tier either
 * its courts by name or one row standing for all of them.
 *
 * A tier with no courts emits no row rather than an empty heading; the
 * jurisdiction genuinely has none in the corpus.
 */
export const caseLawCourtStatusRows = ({
  activity,
  buckets,
  country,
  courtWeights,
  total,
}: CourtStatusRowsOptions): CaseLawCourtStatusRow[] => {
  const rows = courtRowsByTier({ activity, buckets, country, courtWeights });
  const listed = buckets.reduce((sum, { count }) => sum + count, 0);
  // Never negative: the buckets and the total come from the same projection,
  // and a bucket sum above it would be the projection contradicting itself.
  // Clamped rather than asserted, because the two are read separately and a
  // reindex may land between the reads.
  const unlisted = Math.max(0, total - listed);
  if (unlisted === 0) {
    return rows;
  }
  rows.push({
    type: "unlisted",
    tier: "other",
    listed: buckets.length,
    decisions: unlisted,
  });
  return rows;
};

const courtRowsByTier = ({
  activity,
  buckets,
  country,
  courtWeights,
}: Omit<CourtStatusRowsOptions, "total">): CaseLawCourtStatusRow[] => {
  // A list per tier up front, so every tier has one to collect into and there
  // is no absent case to stand in for. A tier added to the union has to be
  // given one here before this compiles. Annotated, not inferred: empty
  // literals would otherwise infer `never[]`.
  const byTier: Record<CourtTierLabel, FacetBucket[]> = {
    constitutional: [],
    supreme: [],
    regional: [],
    other: [],
  };
  for (const bucket of buckets) {
    byTier[courtTierLabelFromMap(courtWeights, bucket.value, country)].push(
      bucket,
    );
  }

  return COURT_TIER_LABELS.flatMap((tier) => {
    // Largest first within a tier, so the court a reader is most likely to
    // recognise leads it.
    const courts = byTier[tier].toSorted(
      (left, right) => right.count - left.count,
    );
    if (courts.length === 0) {
      return [];
    }
    const named =
      TIER_ROWS[tier] === "named" || courts.length <= COURTS_NAMED_PER_TIER;
    if (named) {
      return courts.map((bucket): CaseLawCourtStatusRow => {
        const { addedLastDay, addedLastWeek, updatedAt } =
          activity.get(bucket.value) ?? NO_ACTIVITY;
        // No ECLI to read here: the facets carry court names, so the chip is
        // whatever the jurisdiction's apex-court names state, and nothing for
        // a court they do not.
        return {
          type: "court",
          court: bucket.value,
          courtAbbreviation:
            courtAbbreviation({ country, court: bucket.value }) ?? null,
          tier,
          decisions: bucket.count,
          addedLastDay,
          addedLastWeek,
          updatedAt,
        };
      });
    }

    let decisions = 0;
    let addedLastDay = 0;
    let addedLastWeek = 0;
    let updatedAt: string | null = null;
    for (const bucket of courts) {
      const court = activity.get(bucket.value) ?? NO_ACTIVITY;
      decisions += bucket.count;
      addedLastDay += court.addedLastDay;
      addedLastWeek += court.addedLastWeek;
      updatedAt = laterOf(updatedAt, court.updatedAt);
    }
    return [
      {
        type: "tier",
        tier,
        courts: courts.length,
        decisions,
        addedLastDay,
        addedLastWeek,
        updatedAt,
      },
    ];
  });
};
