import { Result, TaggedError } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase, TransactionOf } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
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
 * The numerator is a persisted planner estimate. Refreshing explains a
 * source-filtered SELECT without executing it, so the ingestion cycle never
 * walks the source's corpus range. Public readers still read only the stored
 * pair. A durable attempt timestamp bounds both successful and failed refreshes.
 */

/**
 * The sources table holds one row per registered adapter key, a set fixed in
 * code. The bound is the lint-visible statement of that.
 */
const SOURCE_READ_LIMIT = 100;

/**
 * `reportedTotal` is a PostgreSQL `integer`. A larger value is rejected here
 * so the caller gets the same `SourceReportedTotalError` as any other unusable
 * number, instead of a numeric-overflow raised mid-transaction by the
 * database, which a batched caller cannot attribute to one source.
 */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** A reported total the sources table cannot hold or the domain cannot mean. */
export class SourceReportedTotalError extends TaggedError(
  "SourceReportedTotalError",
)<{
  message: string;
}> {}

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
 * range. Callers report the `SourceReportedTotalError` rather than restating
 * these rules.
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
    throw new SourceReportedTotalError({
      message: `reported total must be a positive integer no greater than ${POSTGRES_INTEGER_MAX}, got: ${total}`,
    });
  }
  if (Number.isNaN(asOf.getTime())) {
    throw new SourceReportedTotalError({
      message: "reported total asOf must be a valid date",
    });
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

/** Minimum interval between attempts, including failures and worker restarts. */
export const SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Stable source phases spread normal refreshes; overdue slots remain due. */
export const sourceStoredTotalNextRefreshAt = (
  sourceId: SafeId<"caseLawSource">,
  earliest: Date,
): Date => {
  const phase =
    createHash("sha256").update(sourceId).digest().readUInt32BE(0) %
    SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS;
  const period = Math.ceil(
    (earliest.getTime() - phase) / SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
  );
  return new Date(period * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + phase);
};

const STORED_TOTAL_STATEMENT_TIMEOUT_MS = 5000;
const STORED_TOTAL_LOCK_TIMEOUT_MS = 1000;
const STORED_TOTAL_ABORT_TIMEOUT_MS = 10_000;

export type StoredTotalRefresh =
  | "refreshed"
  /** A recent measurement or attempt prevents another refresh. */
  | "fresh"
  /** The previous figure stands; a claimed attempt still backs off. */
  | "unavailable"
  /** Admission held; the overdue slot remains available for a later cycle. */
  | "held";

type RefreshSourceStoredTotalOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  acquireAdmission: () => Promise<"granted" | "held">;
  estimateSource?: (sourceId: SafeId<"caseLawSource">) => Promise<number>;
};

// EXPLAIN never executes this SELECT; ANALYZE would reintroduce the corpus scan.
export const explainSourceStoredTotalQuery = (
  sourceId: SafeId<"caseLawSource">,
) =>
  sql`EXPLAIN (FORMAT JSON) SELECT id FROM case_law_decisions WHERE source_id = ${sourceId}`;

const storedTotalEstimateSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(POSTGRES_INTEGER_MAX),
);

const sourceStoredTotalPlanSchema = v.tuple([
  v.object({
    "QUERY PLAN": v.tuple([
      v.object({
        Plan: v.object({
          "Plan Rows": storedTotalEstimateSchema,
        }),
      }),
    ]),
  }),
]);

/** Estimate under the ingestion role; no corpus rows are read or counted. */
export const estimateSourceThroughIngestionRole = async (
  database: RlsDatabase,
  sourceId: SafeId<"caseLawSource">,
): Promise<number> => {
  const ingestionDb = createIngestionDb(database, {
    laneWaitMs: STORED_TOTAL_STATEMENT_TIMEOUT_MS,
  });
  return await ingestionDb(async (tx) => {
    const plans = v.parse(
      sourceStoredTotalPlanSchema,
      executedRows(await tx.execute(explainSourceStoredTotalQuery(sourceId))),
    );
    return plans[0]["QUERY PLAN"][0].Plan["Plan Rows"];
  });
};

const estimateSourceOnDedicatedConnection = async (
  sourceId: SafeId<"caseLawSource">,
): Promise<number> => {
  const { withLongRunningConnection } =
    await import("@/api/db/long-running-connection");
  return await withLongRunningConnection(
    {
      statementTimeout: STORED_TOTAL_STATEMENT_TIMEOUT_MS,
      lockTimeout: STORED_TOTAL_LOCK_TIMEOUT_MS,
      signal: AbortSignal.timeout(STORED_TOTAL_ABORT_TIMEOUT_MS),
    },
    async ({ db }) =>
      await estimateSourceThroughIngestionRole(
        markRlsDatabase({
          transaction: async <T>(
            fn: (tx: TransactionOf<typeof db>) => Promise<T>,
          ): Promise<T> => await db.transaction(fn),
        }),
        sourceId,
      ),
  );
};

type SourceStoredTotalRefreshClaimOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};

/** The primary-key claim commits before planning and survives a failed refresh. */
export const sourceStoredTotalRefreshClaim = ({
  tx,
  sourceId,
  now,
}: SourceStoredTotalRefreshClaimOptions) => {
  const dueBefore = new Date(
    now.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
  );
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  return tx
    .update(caseLawSources)
    .set({ storedTotalAttemptedAt: now })
    .where(
      and(
        eq(caseLawSources.id, sourceId),
        sql`${caseLawSources.storedTotalNextRefreshAt} <= ${now.toISOString()}::timestamptz`,
        or(
          sql`greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf}) IS NULL`,
          sql`greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf}) <= ${dueBefore.toISOString()}::timestamptz`,
        ),
      ),
    )
    .returning({ id: caseLawSources.id });
};

const initialSourceRefreshSlot = (
  sourceId: SafeId<"caseLawSource">,
  now: Date,
) => {
  const phase = sourceStoredTotalNextRefreshAt(sourceId, new Date(0)).getTime();
  return sql`to_timestamp((
    ${phase} + ceil((greatest(
      ${now.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + 1},
      extract(epoch FROM greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf})) * 1000 + ${SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS}
    ) - ${phase}) / ${SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS}) * ${SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS}
  ) / 1000)`;
};

/** Failed work backs off; held admission leaves the durable overdue slot intact. */
export const refreshSourceStoredTotal = async ({
  now,
  scopedDb,
  sourceId,
  acquireAdmission,
  estimateSource = estimateSourceOnDedicatedConnection,
}: RefreshSourceStoredTotalOptions): Promise<StoredTotalRefresh> => {
  let claimedAttempt: { previousAttempt: Date | null } | undefined;
  const attempt = await Result.tryPromise(async () => {
    const claimed = await scopedDb(async (tx) => {
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .update(caseLawSources)
        .set({
          storedTotalNextRefreshAt: initialSourceRefreshSlot(sourceId, now),
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            isNull(caseLawSources.storedTotalNextRefreshAt),
          ),
        );
      const previous = (
        await tx
          .select({ attemptedAt: caseLawSources.storedTotalAttemptedAt })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
          .for("update")
      ).at(0);
      if (previous === undefined) {
        return undefined;
      }
      const updated = await sourceStoredTotalRefreshClaim({
        tx,
        sourceId,
        now,
      });
      return updated.length === 0
        ? undefined
        : { previousAttempt: previous.attemptedAt };
    });
    if (claimed === undefined) {
      return "fresh" as const;
    }
    claimedAttempt = claimed;
    if ((await acquireAdmission()) === "held") {
      await scopedDb(async (tx) => {
        // audit: skip — public case-law corpus bookkeeping, no workspace data
        await tx
          .update(caseLawSources)
          .set({ storedTotalAttemptedAt: claimed.previousAttempt })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              sql`${caseLawSources.storedTotalAttemptedAt} = ${now.toISOString()}::timestamptz`,
            ),
          );
      });
      claimedAttempt = undefined;
      logger.info("case_law.source_stored_total.held", { sourceId });
      return "held" as const;
    }
    const estimated = v.parse(
      storedTotalEstimateSchema,
      await estimateSource(sourceId),
    );
    return await scopedDb(async (tx) => {
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      const written = await tx
        .update(caseLawSources)
        .set({
          storedTotal: estimated,
          storedTotalAsOf: now,
          storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
            sourceId,
            new Date(now.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
          ),
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            sql`${caseLawSources.storedTotalAttemptedAt} = ${now.toISOString()}::timestamptz`,
            or(
              isNull(caseLawSources.storedTotalAsOf),
              sql`${caseLawSources.storedTotalAsOf} <= ${now.toISOString()}::timestamptz`,
            ),
          ),
        )
        .returning({ id: caseLawSources.id });
      return written.length > 0 ? ("refreshed" as const) : ("fresh" as const);
    });
  });
  if (Result.isError(attempt)) {
    if (claimedAttempt !== undefined) {
      const rescheduled = await Result.tryPromise(
        async () =>
          await scopedDb(async (tx) => {
            // audit: skip — public case-law corpus bookkeeping, no workspace data
            await tx
              .update(caseLawSources)
              .set({
                storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
                  sourceId,
                  new Date(
                    now.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
                  ),
                ),
              })
              .where(
                and(
                  eq(caseLawSources.id, sourceId),
                  sql`${caseLawSources.storedTotalAttemptedAt} = ${now.toISOString()}::timestamptz`,
                ),
              );
          }),
      );
      if (Result.isError(rescheduled)) {
        logger.warn("case_law.source_stored_total.schedule_unavailable", {
          sourceId,
          ...errorSystemFields(rescheduled.error),
        });
      }
    }
    logger.warn("case_law.source_stored_total.unavailable", {
      sourceId,
      ...errorSystemFields(attempt.error),
      ...pgErrorFields(attempt.error),
    });
    return "unavailable";
  }
  return attempt.value;
};

type RefreshNextSourceStoredTotalOptions = Omit<
  RefreshSourceStoredTotalOptions,
  "sourceId"
>;

/** One oldest eligible source per ingestion cycle, including after a restart. */
export const refreshNextSourceStoredTotal = async (
  options: RefreshNextSourceStoredTotalOptions,
): Promise<StoredTotalRefresh> => {
  const { scopedDb, now } = options;
  const selected = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        const unscheduled = await tx
          .select({ id: caseLawSources.id })
          .from(caseLawSources)
          .where(isNull(caseLawSources.storedTotalNextRefreshAt))
          .limit(SOURCE_READ_LIMIT);
        for (const source of unscheduled) {
          // db-await-in-loop: the fixed adapter catalog is bounded to SOURCE_READ_LIMIT; initialize durable phases in one transaction.
          // audit: skip — public case-law corpus bookkeeping, no workspace data
          await tx
            .update(caseLawSources)
            .set({
              storedTotalNextRefreshAt: initialSourceRefreshSlot(
                source.id,
                now,
              ),
            })
            .where(
              and(
                eq(caseLawSources.id, source.id),
                isNull(caseLawSources.storedTotalNextRefreshAt),
              ),
            );
        }
        return (
          await tx
            .select({ id: caseLawSources.id })
            .from(caseLawSources)
            .where(
              and(
                sql`${caseLawSources.storedTotalNextRefreshAt} <= ${now.toISOString()}::timestamptz`,
                or(
                  sql`greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf}) IS NULL`,
                  sql`greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf}) <= ${new Date(now.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS).toISOString()}::timestamptz`,
                ),
              ),
            )
            .orderBy(
              asc(caseLawSources.storedTotalNextRefreshAt),
              asc(caseLawSources.id),
            )
            .limit(1)
        ).at(0);
      }),
  );
  if (Result.isError(selected)) {
    logger.warn("case_law.source_stored_total.selection_unavailable", {
      ...errorSystemFields(selected.error),
    });
    return "unavailable";
  }
  if (selected.value === undefined) {
    return "fresh";
  }
  return await refreshSourceStoredTotal({
    ...options,
    sourceId: selected.value.id,
  });
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
