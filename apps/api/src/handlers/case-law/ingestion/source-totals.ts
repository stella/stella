import { Result, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase, TransactionOf } from "@/api/db/scoped";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

import { recordSourceStoredTotalHold } from "./source-total-hold";

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
 * The numerator is an exact count refreshed in a deterministic daily slot,
 * admitted and budgeted independently. Public readers read only the stored pair. A durable attempt timestamp bounds both successful and failed refreshes.
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
export const SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS = DAY_IN_MS;

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

export const SOURCE_STORED_TOTAL_GLOBAL_SPACING = 10 * 60_000;
/**
 * Global stored-total claims serialize on this database-local bigint key,
 * hashed with seed 0. It is separate from db-load-gate's two-int lock namespace;
 * releasing the transaction ends ownership without clearing the durable spacing.
 */
const SOURCE_STORED_TOTAL_CLAIM_LOCK_KEY = "case-law-source-stored-total";

/** Selector and claim must agree on the deployment-wide start spacing. */
const sourceStoredTotalSpacingAvailable = (now: Date) =>
  sql`NOT EXISTS (SELECT 1 FROM case_law_sources AS recent WHERE recent.stored_total_attempted_at > ${new Date(now.getTime() - SOURCE_STORED_TOTAL_GLOBAL_SPACING).toISOString()}::timestamptz)`;

const STORED_TOTAL_STATEMENT_TIMEOUT_MS = 120_000;
const STORED_TOTAL_LOCK_TIMEOUT_MS = 1000;
const STORED_TOTAL_ABORT_TIMEOUT_MS = 130_000;

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
  readDatabaseNow?: (tx: Transaction) => Promise<Date>;
  acquireAdmission: () => Promise<"granted" | "held" | "unknown">;
  countSource?: (sourceId: SafeId<"caseLawSource">) => Promise<number>;
};

/** The only recurring exact count: one admitted source snapshot per daily slot. */
export const sourceStoredTotalCountQuery = (
  sourceId: SafeId<"caseLawSource">,
) =>
  // sql-perf-allow: bounded by an index-served exact source snapshot, one source/day and one per cycle, 120s
  sql`SELECT count(*)::int AS total FROM case_law_decisions WHERE source_id = ${sourceId}`;

const storedTotalCountSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(POSTGRES_INTEGER_MAX),
);
const sourceCountRowsSchema = v.tuple([
  v.object({ total: storedTotalCountSchema }),
]);

export const countSourceThroughIngestionRole = async (
  database: RlsDatabase,
  sourceId: SafeId<"caseLawSource">,
): Promise<number> => {
  const ingestionDb = createIngestionDb(database, {
    laneWaitMs: STORED_TOTAL_STATEMENT_TIMEOUT_MS,
  });
  return await ingestionDb(
    async (tx) =>
      v.parse(
        sourceCountRowsSchema,
        executedRows(await tx.execute(sourceStoredTotalCountQuery(sourceId))),
      )[0].total,
  );
};

type SourceCountConnectionOptions = {
  prepareConnection?: (connection: ReservedSQL) => Promise<void>;
};

export const countSourceOnDedicatedConnection = async (
  sourceId: SafeId<"caseLawSource">,
  { prepareConnection }: SourceCountConnectionOptions = {},
): Promise<number> => {
  const { withLongRunningConnection } =
    await import("@/api/db/long-running-connection");
  return await withLongRunningConnection(
    {
      statementTimeout: STORED_TOTAL_STATEMENT_TIMEOUT_MS,
      lockTimeout: STORED_TOTAL_LOCK_TIMEOUT_MS,
      signal: AbortSignal.timeout(STORED_TOTAL_ABORT_TIMEOUT_MS),
    },
    async ({ db, connection }) => {
      await prepareConnection?.(connection);
      return await countSourceThroughIngestionRole(
        markRlsDatabase({
          transaction: async <T>(
            fn: (tx: TransactionOf<typeof db>) => Promise<T>,
          ): Promise<T> => await db.transaction(fn),
        }),
        sourceId,
      );
    },
  );
};

const readSourceRefreshDatabaseNow = async (tx: Transaction): Promise<Date> => {
  const row = executedRows(
    await tx.execute(
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS epoch_ms`,
    ),
  ).at(0);
  const clock = v.parse(
    v.object({ epoch_ms: v.pipe(v.number(), v.check(Number.isFinite)) }),
    row,
  );
  return new Date(clock.epoch_ms);
};

type SourceStoredTotalRefreshClaimOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};

/** The primary-key claim commits before counting and survives a failed refresh. */
export const sourceStoredTotalRefreshClaim = ({
  tx,
  sourceId,
  now,
}: SourceStoredTotalRefreshClaimOptions) =>
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  tx
    .update(caseLawSources)
    .set({
      storedTotalAttemptedAt: now,
      storedTotalHeldSince: null,
      storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
        sourceId,
        new Date(now.getTime() + 1),
      ),
    })
    .where(
      and(
        eq(caseLawSources.id, sourceId),
        sourceStoredTotalSpacingAvailable(now),
        or(
          isNull(caseLawSources.storedTotalNextRefreshAt),
          sql`${caseLawSources.storedTotalNextRefreshAt} <= ${now.toISOString()}::timestamptz`,
        ),
      ),
    )
    .returning({ id: caseLawSources.id });

const initialSourceRefreshSlot = (
  sourceId: SafeId<"caseLawSource">,
  now: Date,
) => {
  const phase = sourceStoredTotalNextRefreshAt(sourceId, new Date(0)).getTime();
  return sql`to_timestamp((
    ${phase} + ceil((greatest(
      ${now.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + 1},
      extract(epoch FROM greatest(${caseLawSources.storedTotalAttemptedAt}, ${caseLawSources.storedTotalAsOf})) * 1000 + 1
    ) - ${phase}) / ${SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS}) * ${SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS}
  ) / 1000)`;
};

/** Admission precedes the durable claim; failed counts retain the claimed backoff. */
export const refreshSourceStoredTotal = async ({
  scopedDb,
  sourceId,
  acquireAdmission,
  readDatabaseNow = readSourceRefreshDatabaseNow,
  countSource = countSourceOnDedicatedConnection,
}: RefreshSourceStoredTotalOptions): Promise<StoredTotalRefresh> => {
  let claimedAt: Date | undefined;
  const attempt = await Result.tryPromise(async () => {
    const candidate = await scopedDb(async (tx) => {
      const now = await readDatabaseNow(tx);
      const row = (
        await tx
          .select({
            due: caseLawSources.storedTotalNextRefreshAt,
            attempted: caseLawSources.storedTotalAttemptedAt,
            asOf: caseLawSources.storedTotalAsOf,
          })
          .from(caseLawSources)
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              sourceStoredTotalSpacingAvailable(now),
            ),
          )
          .limit(1)
      ).at(0);
      if (
        row === undefined ||
        (row.due !== null && row.due.getTime() > now.getTime())
      ) {
        return undefined;
      }
      return { now, slot: row.due ?? new Date(0) };
    });
    if (candidate === undefined) {
      return "fresh" as const;
    }
    const admission = await acquireAdmission();
    if (admission !== "granted") {
      await recordSourceStoredTotalHold({
        scopedDb,
        sourceId,
        now: candidate.now,
        slot: candidate.slot,
        admission,
      });
      logger.info("case_law.source_stored_total.held", { sourceId });
      return "held" as const;
    }
    const claimed = await scopedDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${SOURCE_STORED_TOTAL_CLAIM_LOCK_KEY}, 0))`,
      );
      const now = await readDatabaseNow(tx);
      const rows = await sourceStoredTotalRefreshClaim({ tx, sourceId, now });
      return rows.length === 0 ? undefined : now;
    });
    if (claimed === undefined) {
      return "fresh" as const;
    }
    claimedAt = claimed;
    const total = v.parse(storedTotalCountSchema, await countSource(sourceId));
    return await scopedDb(async (tx) => {
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      const written = await tx
        .update(caseLawSources)
        .set({ storedTotal: total, storedTotalAsOf: claimed })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            sql`${caseLawSources.storedTotalAttemptedAt} = ${claimed.toISOString()}::timestamptz`,
            or(
              isNull(caseLawSources.storedTotalAsOf),
              sql`${caseLawSources.storedTotalAsOf} <= ${claimed.toISOString()}::timestamptz`,
            ),
          ),
        )
        .returning({ id: caseLawSources.id });
      return written.length > 0 ? ("refreshed" as const) : ("fresh" as const);
    });
  });
  if (Result.isError(attempt)) {
    logger.warn("case_law.source_stored_total.unavailable", {
      sourceId,
      ...errorSystemFields(attempt.error),
      ...pgErrorFields(attempt.error),
    });
    const failedClaim = claimedAt;
    if (failedClaim !== undefined) {
      const backoff = await Result.tryPromise(
        async () =>
          await scopedDb(async (tx) => {
            // audit: skip — failed public corpus refresh retains durable daily backoff.
            await tx
              .update(caseLawSources)
              .set({
                storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
                  sourceId,
                  new Date(
                    failedClaim.getTime() +
                      SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
                  ),
                ),
              })
              .where(
                and(
                  eq(caseLawSources.id, sourceId),
                  sql`${caseLawSources.storedTotalAttemptedAt} = ${failedClaim.toISOString()}::timestamptz`,
                ),
              );
          }),
      );
      if (Result.isError(backoff)) {
        logger.warn("case_law.source_stored_total.backoff_unavailable", {
          sourceId,
          ...pgErrorFields(backoff.error),
        });
      }
    }
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
  const { scopedDb, readDatabaseNow = readSourceRefreshDatabaseNow } = options;
  const selected = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        const now = await readDatabaseNow(tx);
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
                sourceStoredTotalSpacingAvailable(now),
              ),
            )
            .orderBy(
              asc(caseLawSources.storedTotalNextRefreshAt),
              asc(caseLawSources.id),
            )
            .limit(1)
            .for("update", { skipLocked: true })
        ).at(0);
      }),
  );
  if (Result.isError(selected)) {
    captureError(selected.error, {
      step: "refreshNextSourceStoredTotal.select",
    });
    logger.warn("case_law.source_stored_total.selection_unavailable", {
      ...errorSystemFields(selected.error),
      ...pgErrorFields(selected.error),
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
