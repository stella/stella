import { panic, Result, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { defaultConfig } from "@stll/db-load-gate/health";
import type { HealthConfig, Signal } from "@stll/db-load-gate/health";
import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { createDatabaseLoadVerdictReader } from "@/api/db/backfill-runtime";
import { CorpusSchemaLaneUnavailableError } from "@/api/db/corpus-schema-lane";
import type { Transaction } from "@/api/db/root";
import type { IngestionScopedDb, ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase, TransactionOf } from "@/api/db/scoped";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { remainingCycleMs } from "@/api/lib/legal-search/cycle-deadline";
import type { CycleDeadline } from "@/api/lib/legal-search/cycle-deadline";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { pgErrorFields } from "@/api/lib/pg-error";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

import { createSourceStoredTotalAdmission } from "./source-total-admission";
import { emitSourceStoredTotalHoldHeartbeats } from "./source-total-hold";

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

type SourceTotalValues = Pick<
  typeof caseLawSources.$inferInsert,
  | "reportedTotal"
  | "reportedTotalAsOf"
  | "reportedTotalOrigin"
  | "storedTotal"
  | "storedTotalAsOf"
  | "storedTotalAttemptedAt"
  | "storedTotalNextRefreshAt"
  | "storedTotalHeldSince"
  | "storedTotalWarnedSlot"
>;

type WriteSourceTotalsOptions = {
  tx: Transaction;
  values: { [Key in keyof SourceTotalValues]?: SourceTotalValues[Key] | SQL };
  where: SQL | undefined;
};

/** One mutation owner for public coverage figures and their refresh state. */
const writeSourceTotals = ({ tx, values, where }: WriteSourceTotalsOptions) => {
  if (where === undefined) {
    return panic("Source total writes require an explicit source predicate");
  }
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  return tx.update(caseLawSources).set(values).where(where).returning({
    id: caseLawSources.id,
  });
};

const UNKNOWN_HOLD_CAUSE = "indicators_unavailable";

type RecordSourceHoldOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  slot: Date;
  admission: "held" | "unknown";
};

/** Persist every due gate hold; a row lock deduplicates UNKNOWN warnings. */
export const recordSourceStoredTotalHold = async ({
  scopedDb,
  sourceId,
  now,
  slot,
  admission,
}: RecordSourceHoldOptions) => {
  const warn = await scopedDb(async (tx) => {
    const row = (
      await tx
        .select({
          due: caseLawSources.storedTotalNextRefreshAt,
          heldSince: caseLawSources.storedTotalHeldSince,
          warnedSlot: caseLawSources.storedTotalWarnedSlot,
        })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
        .for("update")
    ).at(0);
    if (
      row === undefined ||
      (row.due?.getTime() ?? 0) !== slot.getTime() ||
      (row.due !== null && row.due.getTime() > now.getTime())
    ) {
      return false;
    }
    const shouldWarn =
      admission === "unknown" && row.warnedSlot?.getTime() !== slot.getTime();
    if (row.heldSince !== null && !shouldWarn) {
      return false;
    }
    await writeSourceTotals({
      tx,
      values: {
        storedTotalHeldSince: row.heldSince ?? now,
        storedTotalWarnedSlot: shouldWarn ? slot : row.warnedSlot,
      },
      where: eq(caseLawSources.id, sourceId),
    });
    return shouldWarn;
  });
  if (warn) {
    logger.warn("case_law.source_stored_total.held_unknown", {
      sourceId,
      holdCause: UNKNOWN_HOLD_CAUSE,
      slot: slot.toISOString(),
    });
  }
};

const sourceStoredTotalSelectionFailure = failureSink({
  event: "case_law.source_stored_total.selection_unavailable",
  expected: [],
});

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
    const updated = await writeSourceTotals({
      tx,
      values: {
        reportedTotal: total,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: origin,
      },
      where: eq(caseLawSources.adapterKey, adapterKey),
    });

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
    hashSha256Bytes(sourceId).readUInt32BE(0) %
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
  scopedDb: IngestionScopedDb;
  sourceId: SafeId<"caseLawSource">;
  readDatabaseNow?: (tx: Transaction) => Promise<Date>;
  acquireAdmission: (
    phase?: "reserve" | "start",
  ) => Promise<"granted" | "held" | "unknown">;
  deadline?: CycleDeadline;
  signal?: AbortSignal;
  countSource?: (
    sourceId: SafeId<"caseLawSource">,
    options?: SourceCountConnectionOptions,
  ) => Promise<number | Result<number, SourceStoredTotalAdmissionExpired>>;
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

class SourceStoredTotalAdmissionExpired extends TaggedError(
  "SourceStoredTotalAdmissionExpired",
)<{
  message: string;
}> {}

type SourceCountConnectionOptions = {
  prepareConnection?: (connection: ReservedSQL) => Promise<void>;
  signal?: AbortSignal;
  remainingStartWaitMs?: () => number;
  validateStart?: () => Promise<"granted" | "held" | "unknown">;
};

type SourceCountIngestionOptions = SourceCountConnectionOptions & {
  database: RlsDatabase;
  sourceId: SafeId<"caseLawSource">;
};

export const countSourceThroughIngestionRole = async ({
  database,
  sourceId,
  signal,
  remainingStartWaitMs,
  validateStart,
}: SourceCountIngestionOptions): Promise<
  Result<number, SourceStoredTotalAdmissionExpired>
> => {
  const ingestionDb = createIngestionDb(database, {
    laneWaitMs: Math.max(
      0,
      Math.ceil(remainingStartWaitMs?.() ?? STORED_TOTAL_STATEMENT_TIMEOUT_MS),
    ),
    ...(signal === undefined ? {} : { signal }),
  });
  return await ingestionDb(async (tx) => {
    signal?.throwIfAborted();
    if (validateStart !== undefined && (await validateStart()) !== "granted") {
      return Result.err(
        new SourceStoredTotalAdmissionExpired({
          message: "Stored-total count admission expired before SQL start",
        }),
      );
    }
    signal?.throwIfAborted();
    return Result.ok(
      v.parse(
        sourceCountRowsSchema,
        executedRows(await tx.execute(sourceStoredTotalCountQuery(sourceId))),
      )[0].total,
    );
  });
};

export const countSourceOnDedicatedConnection = async (
  sourceId: SafeId<"caseLawSource">,
  {
    prepareConnection,
    signal: cycleSignal,
    remainingStartWaitMs,
    validateStart,
  }: SourceCountConnectionOptions = {},
): Promise<Result<number, SourceStoredTotalAdmissionExpired>> => {
  const { withLongRunningConnection } =
    await import("@/api/db/long-running-connection");
  const timeout = AbortSignal.timeout(STORED_TOTAL_ABORT_TIMEOUT_MS);
  const signal =
    cycleSignal === undefined
      ? timeout
      : AbortSignal.any([cycleSignal, timeout]);
  return await withLongRunningConnection(
    {
      statementTimeout: STORED_TOTAL_STATEMENT_TIMEOUT_MS,
      lockTimeout: STORED_TOTAL_LOCK_TIMEOUT_MS,
      signal,
    },
    async ({ db, connection }) => {
      await prepareConnection?.(connection);
      return await countSourceThroughIngestionRole({
        database: markRlsDatabase({
          transaction: async <T>(
            fn: (tx: TransactionOf<typeof db>) => Promise<T>,
          ): Promise<T> => await db.transaction(fn),
        }),
        sourceId,
        signal,
        ...(remainingStartWaitMs === undefined ? {} : { remainingStartWaitMs }),
        ...(validateStart === undefined ? {} : { validateStart }),
      });
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
    v.object({ epoch_ms: v.pipe(v.number(), v.finite()) }),
    row,
  );
  return new Date(clock.epoch_ms);
};

type SourceStoredTotalRefreshClaimOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};

/** Commit a full failure backoff first; only a fenced success restores the normal phase. */
export const sourceStoredTotalRefreshClaim = ({
  tx,
  sourceId,
  now,
}: SourceStoredTotalRefreshClaimOptions) =>
  writeSourceTotals({
    tx,
    values: {
      storedTotalAttemptedAt: now,
      storedTotalHeldSince: null,
      storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
        sourceId,
        new Date(now.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
      ),
    },
    where: and(
      eq(caseLawSources.id, sourceId),
      sourceStoredTotalSpacingAvailable(now),
      or(
        isNull(caseLawSources.storedTotalNextRefreshAt),
        sql`${caseLawSources.storedTotalNextRefreshAt} <= ${now.toISOString()}::timestamptz`,
      ),
    ),
  });

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
  deadline,
  signal = deadline?.signal,
  readDatabaseNow = readSourceRefreshDatabaseNow,
  countSource = countSourceOnDedicatedConnection,
}: RefreshSourceStoredTotalOptions): Promise<StoredTotalRefresh> => {
  const startWaitMs = () =>
    Math.max(
      0,
      Math.ceil(
        deadline === undefined
          ? STORED_TOTAL_ABORT_TIMEOUT_MS
          : remainingCycleMs(deadline),
      ),
    );
  const boundedDb: IngestionScopedDb = async (fn) =>
    await scopedDb(fn, {
      laneWaitMs: startWaitMs(),
      ...(signal === undefined ? {} : { signal }),
    });
  const validStart = async () => {
    if (
      signal?.aborted ||
      (deadline !== undefined && remainingCycleMs(deadline) < 0)
    ) {
      return "held" as const;
    }
    return await acquireAdmission("start");
  };
  const attempt = await Result.tryPromise({
    try: async () => {
      signal?.throwIfAborted();
      const candidate = await boundedDb(async (tx) => {
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
          scopedDb: boundedDb,
          sourceId,
          now: candidate.now,
          slot: candidate.slot,
          admission,
        });
        logger.info("case_law.source_stored_total.held", { sourceId });
        return "held" as const;
      }
      const claimed = await boundedDb(async (tx) => {
        await setSharedStatementTimeout(tx, Math.max(1, startWaitMs()));
        await setSharedLockTimeout(
          tx,
          Math.max(1, Math.min(STORED_TOTAL_LOCK_TIMEOUT_MS, startWaitMs())),
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${SOURCE_STORED_TOTAL_CLAIM_LOCK_KEY}, 0))`,
        );
        const startAdmission = await validStart();
        if (startAdmission !== "granted") {
          return { type: "held", admission: startAdmission } as const;
        }
        const now = await readDatabaseNow(tx);
        const rows = await sourceStoredTotalRefreshClaim({ tx, sourceId, now });
        return rows.length === 0 ? undefined : now;
      });
      if (claimed === undefined) {
        return "fresh" as const;
      }
      if (!(claimed instanceof Date)) {
        await recordSourceStoredTotalHold({
          scopedDb: boundedDb,
          sourceId,
          now: candidate.now,
          slot: candidate.slot,
          admission: claimed.admission,
        });
        return "held" as const;
      }
      if ((await validStart()) !== "granted") {
        return "held" as const;
      }
      const counted = await countSource(sourceId, {
        ...(signal === undefined ? {} : { signal }),
        remainingStartWaitMs: startWaitMs,
        validateStart: validStart,
      });
      if (typeof counted !== "number" && counted.isErr()) {
        return "held" as const;
      }
      const total = v.parse(
        storedTotalCountSchema,
        typeof counted === "number" ? counted : counted.value,
      );
      const settlementDb: IngestionScopedDb = async (fn) =>
        await scopedDb(fn, {
          laneWaitMs: Math.max(
            0,
            Math.ceil(
              deadline === undefined
                ? STORED_TOTAL_ABORT_TIMEOUT_MS
                : deadline.expiresAt - performance.now(),
            ),
          ),
          ...(signal === undefined ? {} : { signal }),
        });
      return await settlementDb(async (tx) => {
        const written = await writeSourceTotals({
          tx,
          values: {
            storedTotal: total,
            storedTotalAsOf: claimed,
            storedTotalNextRefreshAt: sourceStoredTotalNextRefreshAt(
              sourceId,
              new Date(claimed.getTime() + 1),
            ),
          },
          where: and(
            eq(caseLawSources.id, sourceId),
            sql`${caseLawSources.storedTotalAttemptedAt} = ${claimed.toISOString()}::timestamptz`,
            or(
              isNull(caseLawSources.storedTotalAsOf),
              sql`${caseLawSources.storedTotalAsOf} <= ${claimed.toISOString()}::timestamptz`,
            ),
          ),
        });
        return written.length > 0 ? ("refreshed" as const) : ("fresh" as const);
      });
    },
    catch: (error) => error,
  });
  if (Result.isError(attempt)) {
    if (CorpusSchemaLaneUnavailableError.is(attempt.error) || signal?.aborted) {
      return "held";
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
  const {
    scopedDb: baseDb,
    readDatabaseNow = readSourceRefreshDatabaseNow,
    deadline,
    signal = deadline?.signal,
  } = options;
  const scopedDb: IngestionScopedDb = async (fn) =>
    await baseDb(fn, {
      laneWaitMs: Math.max(
        0,
        Math.ceil(
          deadline === undefined
            ? STORED_TOTAL_ABORT_TIMEOUT_MS
            : remainingCycleMs(deadline),
        ),
      ),
      ...(signal === undefined ? {} : { signal }),
    });
  const selected = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        const now = await readDatabaseNow(tx);
        const unscheduled = await tx
          .select({ id: caseLawSources.id })
          .from(caseLawSources)
          .where(isNull(caseLawSources.storedTotalNextRefreshAt))
          .limit(SOURCE_READ_LIMIT);
        if (unscheduled.length > 0) {
          await writeSourceTotals({
            tx,
            values: {
              storedTotalNextRefreshAt: sqlCaseFragment({
                operand: sql`${caseLawSources.id}`,
                branches: unscheduled.map(
                  (source) =>
                    sql`WHEN ${source.id} THEN ${initialSourceRefreshSlot(source.id, now)}::timestamptz`,
                ),
                fallback: sql`${caseLawSources.storedTotalNextRefreshAt}`,
              }),
            },
            where: and(
              inArray(
                caseLawSources.id,
                unscheduled.map((source) => source.id),
              ),
              isNull(caseLawSources.storedTotalNextRefreshAt),
            ),
          });
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
    observeFailure(selected.error, {
      sink: sourceStoredTotalSelectionFailure,
      ctx: { step: "refreshNextSourceStoredTotal.select" },
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

const sourceStoredTotalHeartbeatFailure = failureSink({
  event: "case_law.source_stored_total.heartbeat_failed",
  expected: [],
});

/** One bound refresh runtime shares its admission budget and hold telemetry across runner cycles. */
type SourceStoredTotalMaintenanceOptions = {
  clock?: () => number;
  readEbsSignal?: () => Promise<Signal>;
  config?: HealthConfig;
};

export const createSourceStoredTotalMaintenanceRuntime = (
  scopedDb: IngestionScopedDb,
  {
    clock = () => Temporal.Now.instant().epochMilliseconds,
    readEbsSignal,
    config = defaultConfig,
  }: SourceStoredTotalMaintenanceOptions = {},
) => {
  const readVerdict = createDatabaseLoadVerdictReader({
    db: { transaction: scopedDb },
    tableName: "case_law_decisions",
    clock,
    config,
    warn: logger.warn,
    ...(readEbsSignal === undefined ? {} : { readEbsSignal }),
  });
  const acquireAdmission = createSourceStoredTotalAdmission({
    config,
    readVerdict: async ({ deadline }) =>
      await readVerdict({
        laneWaitMs: Math.max(
          0,
          Math.ceil(
            Math.min(
              config.readTimeoutMs,
              deadline === undefined ? 0 : remainingCycleMs(deadline),
            ),
          ),
        ),
        ...(deadline === undefined ? {} : { signal: deadline.signal }),
      }),
  });
  return {
    acquireAdmission,
    emitHoldHeartbeat: async () =>
      await emitSourceStoredTotalHoldHeartbeats(scopedDb),
    observeHeartbeatFailure: (error: unknown) => {
      observeFailure(error, { sink: sourceStoredTotalHeartbeatFailure });
    },
  };
};
