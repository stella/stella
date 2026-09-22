import { Result } from "better-result";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

/**
 * Both halves of a source's coverage figure, and the only writer of either.
 *
 * The denominator is what a publisher reports holding. Several publishers
 * expose no count cheaply, so it is persisted rather than recomputed: polled
 * from the adapter where one implements `getTotalCount`, supplied by an
 * operator where none does. This module keeps `reportedTotal`,
 * `reportedTotalAsOf` and `reportedTotalOrigin` in the "all set" state — the
 * columns are nullable so a source that has never been measured reads as
 * unknown rather than as zero.
 *
 * The numerator is what the corpus actually holds, and it is counted here for
 * the same reason the denominator is stored: a public request must never pay
 * for it. Counting one source is a walk of its whole range of
 * `case_law_decisions_source_generation_cursor_idx`, which on this corpus is
 * seconds, and the public reader that would otherwise run it holds a
 * two-connection pool shared with every other public page. The ingestion
 * connection pays it instead, at most once per
 * `SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS`.
 */

/**
 * The sources table holds one row per registered adapter key, a set fixed in
 * code. The bound is the lint-visible statement of that.
 */
const SOURCE_READ_LIMIT = 100;

/**
 * `reportedTotal` is a PostgreSQL `integer`. A larger value is rejected here
 * so the caller gets the same boundary `TypeError` as any other unusable
 * number, instead of a numeric-overflow raised mid-transaction by the
 * database, which a batched caller cannot attribute to one source.
 */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

type SetSourceReportedTotalOptions = {
  scopedDb: ScopedDb;
  adapterKey: string;
  total: number;
  asOf: Date;
  origin: SourceTotalOrigin;
};

export type SourceReportedTotal = {
  adapterKey: string;
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedTotalOrigin: SourceTotalOrigin | null;
};

/**
 * Record what a publisher reports holding for one source.
 *
 * This is the only place the number is judged, so it rejects everything the
 * column cannot hold or the domain cannot mean: zero and below (no publisher
 * reports holding nothing, and storing it would read downstream as complete
 * coverage of an empty corpus), anything not a whole number (a parse that
 * yielded NaN or infinity, a fraction), and anything past the column's
 * range. Callers report the `TypeError` rather than restating these rules.
 *
 * Returns false when no source carries `adapterKey`.
 */
export const setSourceReportedTotal = async ({
  scopedDb,
  adapterKey,
  total,
  asOf,
  origin,
}: SetSourceReportedTotalOptions): Promise<boolean> => {
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    total > POSTGRES_INTEGER_MAX
  ) {
    throw new TypeError(
      `reported total must be a positive integer no greater than ${POSTGRES_INTEGER_MAX}, got: ${total}`,
    );
  }
  if (Number.isNaN(asOf.getTime())) {
    throw new TypeError("reported total asOf must be a valid date");
  }

  return await scopedDb(async (tx) => {
    // audit: skip — public case-law corpus bookkeeping, no workspace data
    const updated = await tx
      .update(caseLawSources)
      .set({
        reportedTotal: total,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: origin,
      })
      .where(eq(caseLawSources.adapterKey, adapterKey))
      .returning({ adapterKey: caseLawSources.adapterKey });

    return updated.length > 0;
  });
};

/**
 * How long a stored count stands before the next sync cycle recounts.
 *
 * A busy adapter completes a cycle every few minutes; counting on each one
 * would spend more of the ingestion connection on bookkeeping than on
 * ingesting. Six hours keeps the published figure within a quarter-day of the
 * corpus while costing each source four counts a day.
 */
export const SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How long the count itself may run before it is abandoned.
 *
 * Generous, because this is the ingestion connection and the count is the
 * point, and sized so the largest source's count fits with headroom; bounded,
 * because a source whose index has gone cold must not hold the connection
 * open behind the next cycle. Exceeding it leaves the previous figure
 * standing.
 */
const STORED_TOTAL_STATEMENT_TIMEOUT = "120s";

/** What one refresh attempt did. */
export type StoredTotalRefresh =
  /** Counted and written. */
  | "refreshed"
  /** Within the interval, so nothing was counted. */
  | "fresh"
  /** The count did not finish; the previous figure stands. */
  | "unavailable";

type RefreshSourceStoredTotalOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /** The instant the interval is measured from, and the as-of that is written. */
  now: Date;
};

/**
 * Recount one source's stored decisions, unless it was counted recently.
 *
 * Never throws and never changes its caller's outcome. It runs at the end of a
 * sync cycle, where the work that matters has already been committed: a count
 * that times out is bookkeeping that can wait for the next cycle, not a reason
 * to fail an ingestion run or to discard what it wrote.
 *
 * The write is a compare-and-set against the as-of this call observed, so two
 * workers finishing cycles at once converge instead of racing: the second
 * one's `UPDATE` matches no row and it returns having changed nothing. That is
 * also what makes a replay a fixed point — re-running against an already
 * stamped row is the `fresh` branch, and re-running against a row another
 * worker stamped is a no-op write.
 */
export const refreshSourceStoredTotal = async ({
  now,
  scopedDb,
  sourceId,
}: RefreshSourceStoredTotalOptions): Promise<StoredTotalRefresh> => {
  const attempt = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        const observed = (
          await tx
            .select({ asOf: caseLawSources.storedTotalAsOf })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
            .limit(1)
        ).at(0);
        if (observed === undefined) {
          return "unavailable" as const;
        }
        const observedAsOf = observed.asOf;
        if (
          observedAsOf !== null &&
          now.getTime() - observedAsOf.getTime() <
            SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS
        ) {
          return "fresh" as const;
        }

        // Transaction-local, so it reverts with the transaction and a
        // cancelled count needs no unwinding of its own.
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${STORED_TOTAL_STATEMENT_TIMEOUT}, true)`,
        );
        const counted = (
          await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.sourceId, sourceId))
        ).at(0);
        if (counted === undefined) {
          return "unavailable" as const;
        }

        // audit: skip — public case-law corpus bookkeeping, no workspace data
        const written = await tx
          .update(caseLawSources)
          .set({ storedTotal: counted.total, storedTotalAsOf: now })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              or(
                isNull(caseLawSources.storedTotalAsOf),
                lte(caseLawSources.storedTotalAsOf, observedAsOf ?? now),
              ),
            ),
          )
          .returning({ id: caseLawSources.id });

        return written.length > 0 ? ("refreshed" as const) : ("fresh" as const);
      }),
  );

  if (Result.isError(attempt)) {
    // Deliberately not rethrown: see the doc comment. The previous figure and
    // its as-of stay exactly as they were, which is what lets the page say
    // how old the number is rather than showing a wrong one.
    logger.warn("case_law.source_stored_total.unavailable", {
      sourceId,
      ...errorSystemFields(attempt.error),
      ...pgErrorFields(attempt.error),
    });
    return "unavailable";
  }

  return attempt.value;
};

/** Every source's reported total, for coverage reporting. */
export const readSourceReportedTotals = async (
  scopedDb: ScopedDb,
): Promise<SourceReportedTotal[]> =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({
          adapterKey: caseLawSources.adapterKey,
          reportedTotal: caseLawSources.reportedTotal,
          reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
          reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
        })
        .from(caseLawSources)
        .orderBy(caseLawSources.adapterKey)
        .limit(SOURCE_READ_LIMIT),
  );
