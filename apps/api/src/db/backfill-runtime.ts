import { panic, Result } from "better-result";
import { sql, type SQL } from "drizzle-orm";

import {
  BackfillFailedError,
  BackfillHeldError,
} from "@stll/db-load-gate/backfill-pass";
import {
  backfillHeartbeat,
  combine,
  defaultConfig,
  initialBatchState,
} from "@stll/db-load-gate/health";
import type {
  BatchState,
  HealthConfig,
  Signal,
  Verdict,
} from "@stll/db-load-gate/health";
import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
  autovacuumOnTarget,
  busyWindow,
  longTransaction,
} from "@stll/db-load-gate/indicators";
import {
  createHeavyWorkSlot,
  tryAcquireBackfillTransactionSlot,
} from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import { getPgErrorCode } from "@/api/lib/pg-error";

import {
  createEbsSignalReader,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";
import { executedRows } from "../lib/db/executed-rows";
import { isPgError, PG_ERROR } from "../lib/pg-error";
import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";
import { isRecord } from "../lib/type-guards";
import type { BackfillCheckpoint } from "./adaptive-backfill";
import { runAdaptiveBackfillBatch } from "./adaptive-backfill";
import { createBoundedIndicatorQuery } from "./indicator-query";
import type { IndicatorQuery } from "./indicator-query";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import type { Transaction } from "./root";
import type { CreateIngestionDbOptions } from "./scoped";
import { setSharedQueryTimeouts } from "./shared-pool-timeouts";

export {
  BackfillFailedError,
  BackfillHeldError,
} from "@stll/db-load-gate/backfill-pass";

type Query = IndicatorQuery;
export type BackfillRunStatus = ReturnType<typeof backfillHeartbeat> & {
  transitionEvent?: "backfill.yielded" | "backfill.resumed";
};

type RuntimeOptions = {
  name: string;
  tableName: string;
  initialSize: number;
  initialCursor?: string | null;
  config?: HealthConfig | undefined;
  clock?: (() => number) | undefined;
  readVerdict?: (() => Promise<Verdict>) | undefined;
  log?: ((record: unknown) => void) | undefined;
  reporting?: "detailed" | "changes";
  statementTimeoutPolicy?: "defer" | "fail";
  observeStatus?: ((record: BackfillRunStatus) => void) | undefined;
};
type BatchWork<BatchTransaction, Value> = (options: {
  tx: BatchTransaction;
  size: number;
  cursor: string | null;
}) => Promise<{ cursor: string | null; done: boolean; value: Value }>;
type DatabaseRuntimeOptions<BatchTransaction> = RuntimeOptions & {
  runInTransaction: IngestionTransactionRunner<BatchTransaction>;
  transactionQuery: (tx: BatchTransaction) => Query;
  slot: {
    tryAcquire: (tx: NoInfer<BatchTransaction>) => Promise<boolean>;
    release: () => void | Promise<void>;
  };
  close: () => Promise<void>;
};

export const decodeCheckpoint = (row: unknown) => {
  if (!isRecord(row) || !isRecord(row["batch"])) {
    return panic("Invalid backfill checkpoint");
  }
  const b = row["batch"];
  const cursor = row["cursor"];
  const holdCause = b["holdCause"];
  if (cursor !== null && typeof cursor !== "string") {
    return panic("Invalid backfill checkpoint cursor");
  }
  if (
    typeof b["size"] !== "number" ||
    typeof b["sleepMs"] !== "number" ||
    typeof b["stableBatches"] !== "number" ||
    typeof b["holdCount"] !== "number" ||
    !(
      b["smoothedDurationMs"] === null ||
      typeof b["smoothedDurationMs"] === "number"
    ) ||
    !(b["heldSince"] === null || typeof b["heldSince"] === "number") ||
    !(b["holdUntil"] === null || typeof b["holdUntil"] === "number")
  ) {
    return panic("Invalid backfill batch state");
  }
  // Older checkpoints recorded no cause; unknown causes use that same policy.
  const legacyCause = b["heldSince"] === null ? null : "other";
  const decodedCause =
    holdCause === "load" || holdCause === "other" ? holdCause : legacyCause;
  return {
    cursor,
    batch: {
      size: b["size"],
      sleepMs: b["sleepMs"],
      stableBatches: b["stableBatches"],
      holdCount: b["holdCount"],
      smoothedDurationMs: b["smoothedDurationMs"],
      heldSince: b["heldSince"],
      holdCause: decodedCause,
      holdUntil: b["holdUntil"],
    },
  } satisfies BackfillCheckpoint<string | null>;
};

type EbsSignalOptions = { clock: () => number; config: HealthConfig };
const createCachedEbsSignalReader = ({ clock, config }: EbsSignalOptions) => {
  const initializeReader = async () => {
    const { envDbLoadGate } = await import("../env-db-load-gate");
    return createEbsSignalReader({
      configuration: resolveEbsConfiguration(envDbLoadGate),
      clock,
      config,
    });
  };
  let initialized: ReturnType<typeof initializeReader> | undefined;
  return async () => {
    initialized ??= initializeReader();
    return await (
      await initialized
    )();
  };
};

const createVerdictReader = ({
  query,
  tableName,
  clock,
  config,
  sharedReadEbsSignal,
}: {
  query: Query;
  tableName: string;
  clock: () => number;
  config: HealthConfig;
  sharedReadEbsSignal?: () => Promise<Signal>;
}) => {
  const readEbsSignal =
    sharedReadEbsSignal ?? createCachedEbsSignalReader({ clock, config });
  return async () =>
    combine(
      await Promise.all([
        readEbsSignal(),
        longTransaction({
          read: async () => {
            const row = (
              await query(LONG_TRANSACTION_SQL, ["table", tableName])
            ).at(0);
            return isRecord(row) &&
              typeof row["ageMs"] === "number" &&
              typeof row["observedAt"] === "string"
              ? { ageMs: row["ageMs"], observedAt: row["observedAt"] }
              : null;
          },
          now: clock,
          config,
        }),
        autovacuumOnTarget({
          read: async () => {
            const row = (await query(AUTOVACUUM_SQL, [tableName])).at(0);
            return isRecord(row) &&
              typeof row["active"] === "boolean" &&
              typeof row["observedAt"] === "string"
              ? { active: row["active"], observedAt: row["observedAt"] }
              : null;
          },
          now: clock,
          config,
          kind: "backfill_batch",
        }),
        Promise.resolve(busyWindow({ now: clock, config })),
      ]),
    );
};

type RuntimeReportingOptions = {
  reporting: NonNullable<RuntimeOptions["reporting"]>;
  log: NonNullable<RuntimeOptions["log"]>;
  observeStatus: RuntimeOptions["observeStatus"];
};
type RuntimeDecision = {
  status: "done" | "advanced" | "held" | "retry";
  verdict: Verdict;
  holdCause: BatchState["holdCause"];
};

const createRuntimeReporter = ({
  log,
  observeStatus,
  reporting,
}: RuntimeReportingOptions) => {
  let previousDecision: string | undefined;
  let summary: BackfillRunStatus | undefined;
  let firstTransition: BackfillRunStatus["transitionEvent"];
  return {
    logBatch: reporting === "detailed" ? log : () => undefined,
    logDecision: ({ status, verdict, holdCause }: RuntimeDecision) => {
      if (reporting === "detailed") {
        return;
      }
      const settledStatus = status === "done" ? "advanced" : status;
      const identity = JSON.stringify({
        status: settledStatus,
        verdict: verdict.kind,
        signals: verdict.signals.map(({ indicator, kind, reason }) => ({
          indicator,
          kind,
          reason,
        })),
        holdCause,
      });
      if (identity === previousDecision) {
        return;
      }
      log({
        action: "batch_decision",
        status: settledStatus,
        verdict,
        holdCause,
      });
      previousDecision = identity;
    },
    recordStatus: (record: ReturnType<typeof backfillHeartbeat>) => {
      if (reporting === "detailed") {
        observeStatus?.(record);
        return;
      }
      if (
        firstTransition === undefined &&
        (record.event === "backfill.yielded" ||
          record.event === "backfill.resumed")
      ) {
        firstTransition = record.event;
      }
      summary =
        firstTransition === undefined
          ? record
          : {
              ...record,
              event: record.event ?? firstTransition,
              transitionEvent: firstTransition,
            };
    },
    flush: () => {
      if (summary === undefined) {
        return;
      }
      const record = summary;
      summary = undefined;
      observeStatus?.(record);
    },
  };
};

type BackfillBatchResult = Awaited<ReturnType<typeof runAdaptiveBackfillBatch>>;

type BackfillDeferralOptions = {
  name: string;
  result: BackfillBatchResult;
  statementTimeoutPolicy: NonNullable<RuntimeOptions["statementTimeoutPolicy"]>;
};
const throwIfBackfillDeferred = ({
  name,
  result,
  statementTimeoutPolicy,
}: BackfillDeferralOptions) => {
  if (result.status === "retry" && statementTimeoutPolicy === "fail") {
    throw new BackfillFailedError({
      message: `Backfill ${name} batch failed (statement timeout)`,
      cause: result.error,
      holdUntil: result.checkpoint.batch.holdUntil,
      heldSince: result.checkpoint.batch.heldSince,
    });
  }
  if (result.status === "held" || result.status === "retry") {
    throw new BackfillHeldError({
      message: `Backfill ${name} deferred (${result.status})`,
      holdUntil: result.checkpoint.batch.holdUntil,
      heldSince: result.checkpoint.batch.heldSince,
    });
  }
};

const createRuntime = <BatchTransaction>({
  name,
  tableName,
  initialSize,
  initialCursor = null,
  runInTransaction,
  transactionQuery,
  slot,
  close,
  config = defaultConfig,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  readVerdict,
  observeStatus,
  reporting = "detailed",
  statementTimeoutPolicy = "defer",
  log = (record) =>
    process.stderr.write(
      `${JSON.stringify({ event: "database_backfill_decision", name, record })}\n`,
    ),
}: DatabaseRuntimeOptions<BatchTransaction>) => {
  const indicatorQueries = createBoundedIndicatorQuery({
    runInTransaction,
    transactionQuery,
    readTimeoutMs: config.readTimeoutMs,
  });
  const readHealth =
    readVerdict ??
    createVerdictReader({
      query: indicatorQueries.query,
      tableName,
      clock,
      config,
    });
  const readSettledVerdict = async () => {
    try {
      return await readHealth();
    } finally {
      await indicatorQueries.settle();
    }
  };
  const readCheckpoint = async (tx: BatchTransaction) => {
    const q = transactionQuery(tx);
    await setSharedQueryTimeouts(q, {
      statementTimeoutMs: config.batchStatementTimeoutMs,
      lockTimeoutMs: config.batchLockTimeoutMs,
    });
    await q(
      "INSERT INTO database_backfill_states (name, cursor, batch) VALUES ($1, $2, $3::text::jsonb) ON CONFLICT (name) DO NOTHING",
      [
        name,
        initialCursor,
        JSON.stringify({ ...initialBatchState(config), size: initialSize }),
      ],
    );
    const checkpoint = decodeCheckpoint(
      (
        await q(
          "SELECT cursor, batch FROM database_backfill_states WHERE name = $1 FOR UPDATE",
          [name],
        )
      ).at(0),
    );
    const size = Math.min(
      config.maxSize,
      Math.max(config.minSize, checkpoint.batch.size),
    );
    const sleepMs = Math.min(
      config.maxSleepMs,
      Math.max(config.minSleepMs, checkpoint.batch.sleepMs),
    );
    if (
      size !== checkpoint.batch.size ||
      sleepMs !== checkpoint.batch.sleepMs
    ) {
      log({
        action: "checkpoint_clamped",
        previous: {
          size: checkpoint.batch.size,
          sleepMs: checkpoint.batch.sleepMs,
        },
        size,
        sleepMs,
        config,
      });
      checkpoint.batch.size = size;
      checkpoint.batch.sleepMs = sleepMs;
    }
    return checkpoint;
  };
  const persistCheckpoint = async (
    tx: BatchTransaction,
    checkpoint: BackfillCheckpoint<string | null>,
  ) => {
    await transactionQuery(tx)(
      "UPDATE database_backfill_states SET cursor = $2, batch = $3::text::jsonb, updated_at = now() WHERE name = $1",
      [name, checkpoint.cursor, JSON.stringify(checkpoint.batch)],
    );
  };
  const reporter = createRuntimeReporter({ log, observeStatus, reporting });
  const step = async <Value>(work: BatchWork<BatchTransaction, Value>) => {
    const completion: { result?: { value: Value } } = {};
    let previousHeldSince: number | null = null;
    const result = await runAdaptiveBackfillBatch({
      runInTransaction,
      config,
      clock,
      log: reporter.logBatch,
      readVerdict: readSettledVerdict,
      slot,
      readCheckpoint: async (tx) => {
        const checkpoint = await readCheckpoint(tx);
        previousHeldSince = checkpoint.batch.heldSince;
        return checkpoint;
      },
      persistCheckpoint,
      // Work is already a bounded, idempotent SQL batch. It executes in the
      // checkpoint transaction; external I/O must be performed beforehand.
      selectPage: async (tx, cursor, size) => {
        const batch = await work({ tx, cursor, size });
        completion.result = { value: batch.value };
        // A completed pass resets its cursor so later rule changes or source
        // updates can rescan lower keys; each write still needs its predicate.
        return {
          items: [],
          cursor: batch.done ? null : batch.cursor,
          done: batch.done,
        };
      },
      needsWork: () => false,
      persistItems: () => undefined,
      isStatementTimeout: (cause) => isPgError(cause, PG_ERROR.QUERY_CANCELED),
    });
    reporter.logDecision({
      status: result.status,
      verdict: result.verdict,
      holdCause: result.checkpoint.batch.holdCause,
    });
    reporter.recordStatus(
      backfillHeartbeat({
        name,
        state: result.checkpoint.batch,
        previousHeldSince,
        verdict: result.verdict,
        now: clock(),
        config,
      }),
    );
    throwIfBackfillDeferred({ name, result, statementTimeoutPolicy });
    const completedBatch =
      completion.result ?? panic("Backfill batch completed without a result");
    return {
      done: result.status === "done",
      cursor: result.checkpoint.cursor,
      sleepMs: result.checkpoint.batch.sleepMs,
      value: completedBatch.value,
    };
  };
  const recordCompletion = async (
    confirm: (tx: BatchTransaction) => Promise<boolean>,
  ) => {
    const completed = await runInTransaction(async (tx) => {
      const checkpoint = await readCheckpoint(tx);
      if (!(await confirm(tx))) {
        return null;
      }
      // Completion is confirmed against the actual work under this row lock,
      // so a hold left by another worker must not survive completed work.
      // During a rolling deploy an older replica may confirm its older unit
      // set and clear a newer replica's hold. This can reset heldSince/backoff
      // until the next run. Every new unit still reads load and acquires its
      // heavy slot, but a cleared latch can admit throttled work from hardFloor
      // upward instead of waiting for resumeFloor; startFloor separates normal
      // from throttled work. Holds may flap each minute during the rollout,
      // resetting heldSince/backoff, so held-too-long cannot fire until the
      // newer build records its first admission. This bounded rollout tradeoff
      // prevents a concurrent worker's hold from surviving completed work.
      const batch = {
        ...initialBatchState(config),
        size: checkpoint.batch.size,
        sleepMs: checkpoint.batch.sleepMs,
      };
      await persistCheckpoint(tx, { cursor: null, batch });
      return { batch, previousHeldSince: checkpoint.batch.heldSince };
    });
    if (completed === null) {
      return;
    }
    reporter.recordStatus(
      backfillHeartbeat({
        name,
        state: completed.batch,
        previousHeldSince: completed.previousHeldSince,
        verdict: { kind: "normal", signals: [] },
        now: clock(),
        config,
      }),
    );
  };
  return {
    step,
    recordCompletion,
    close: async () => {
      try {
        await close();
      } finally {
        reporter.flush();
      }
    },
  };
};

const drizzleQuery =
  (tx: { execute: (statement: SQL) => PromiseLike<unknown> }): Query =>
  async (statement, parameters = []) => {
    // PgDialect emits the same numbered scalar parameters as the raw repair connections.
    const fragments = statement.split(/\$(\d+)/u);
    const parts = fragments.map((fragment, index) =>
      index % 2 === 0
        ? sql.raw(fragment)
        : sql`${parameters[Number(fragment) - 1]}`,
    );
    return executedRows(await tx.execute(sql.join(parts, sql``)));
  };

/** Read settled health signals without holding a transaction across replay I/O. */
export const createScriptBackfillHealthReader = ({
  db,
  tableName,
  clock,
  config = defaultConfig,
}: {
  db: { transaction: IngestionTransactionRunner<Transaction> };
  tableName: string;
  clock: () => number;
  config?: HealthConfig;
}) => {
  const bounded = createBoundedIndicatorQuery({
    runInTransaction: db.transaction.bind(db),
    transactionQuery: (tx: Transaction) => drizzleQuery(tx),
    readTimeoutMs: config.readTimeoutMs,
  });
  return {
    readVerdict: createVerdictReader({
      query: bounded.query,
      tableName,
      clock,
      config,
    }),
    settle: bounded.settle,
  };
};

const INDICATOR_WARNING_INTERVAL_MS = 10 * 60_000;
const indicatorWarnings = new Map<string, number>();

type IndicatorFailureCause =
  | "function_missing"
  | "execute_denied"
  | "owner_lacks_visibility"
  | "target_access_denied"
  | "ebs_signal_unconfigured"
  | "read_error";

type IndicatorWarningReporter = (
  event: "database_load_gate.indicators_unavailable",
  attributes: { failureCause: IndicatorFailureCause; sqlState?: string },
) => void;

type IndicatorWarningOptions = {
  failureCause: IndicatorFailureCause;
  now: number;
  sqlState?: string;
  warn: IndicatorWarningReporter | undefined;
};

const warnIndicatorFailure = ({
  failureCause,
  now,
  sqlState,
  warn,
}: IndicatorWarningOptions) => {
  if (warn === undefined) {
    return;
  }
  const previous = indicatorWarnings.get(failureCause);
  if (
    previous !== undefined &&
    now - previous < INDICATOR_WARNING_INTERVAL_MS
  ) {
    return;
  }
  indicatorWarnings.set(failureCause, now);
  warn("database_load_gate.indicators_unavailable", {
    failureCause,
    ...(sqlState === undefined ? {} : { sqlState }),
  });
};

const indicatorFailureCause = (error: unknown): IndicatorFailureCause => {
  const state = getPgErrorCode(error);
  if (state === "42883") {
    return "function_missing";
  }
  if (state !== "42501") {
    return "read_error";
  }
  let node = error;
  for (let depth = 0; depth < 10 && isRecord(node); depth += 1) {
    if (node["detail"] === "owner_lacks_visibility") {
      return "owner_lacks_visibility";
    }
    if (node["detail"] === "target_access_denied") {
      return "target_access_denied";
    }
    node = node["cause"];
  }
  return "execute_denied";
};

type DatabaseLoadVerdictReaderOptions = {
  db: {
    transaction: <Value>(
      work: (tx: Transaction) => Promise<Value>,
      options?: CreateIngestionDbOptions,
    ) => Promise<Value>;
  };
  tableName: string;
  config?: HealthConfig;
  clock?: () => number;
  readEbsSignal?: () => Promise<Signal>;
  warn?: IndicatorWarningReporter;
};

/** The database owns the aggregate indicator boundary; unavailable reads hold. */
export const createDatabaseLoadVerdictReader = ({
  db,
  tableName,
  config = defaultConfig,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  readEbsSignal,
  warn,
}: DatabaseLoadVerdictReaderOptions) => {
  const sharedReadEbsSignal =
    readEbsSignal ?? createCachedEbsSignalReader({ clock, config });
  return async (options?: CreateIngestionDbOptions) => {
    // Pooled reads own their operation budget; concurrent callers cannot replace
    // one another's schema-lane deadline or abort signal.
    const indicators = createBoundedIndicatorQuery({
      runInTransaction: async (work) => await db.transaction(work, options),
      transactionQuery: (tx: Transaction) => drizzleQuery(tx),
      readTimeoutMs: config.readTimeoutMs,
    });
    const result = await Result.tryPromise(async () => {
      const snapshotRead = indicators.query(
        `SELECT transaction_age_ms AS "ageMs", vacuum_active AS active,
          pg_catalog.to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
         FROM public.stella_database_load_indicators($1::regclass)`,
        [tableName.includes(".") ? tableName : `public.${tableName}`],
      );
      const snapshot = await snapshotRead;
      const row = snapshot.at(0);
      if (
        !isRecord(row) ||
        typeof row["ageMs"] !== "number" ||
        typeof row["active"] !== "boolean" ||
        typeof row["observedAt"] !== "string"
      ) {
        warnIndicatorFailure({
          failureCause: "read_error",
          now: clock(),
          warn,
        });
        return {
          kind: "unknown",
          signals: [
            {
              indicator: "long_transaction",
              kind: "unknown",
              value: null,
              threshold: null,
              observedAt: null,
              reason: "Database indicators are unavailable",
            },
          ],
        } as const satisfies Verdict;
      }
      const read = createVerdictReader({
        query: async () => await snapshotRead,
        tableName,
        clock,
        config,
        sharedReadEbsSignal,
      });
      const verdict = await read();
      const { envDbLoadGate } = await import("../env-db-load-gate");
      const missingEbs =
        verdict.signals.some(
          ({ indicator, kind }) =>
            indicator === "ebs_balance" && kind === "unknown",
        ) && resolveEbsConfiguration(envDbLoadGate).type === "missing";
      if (missingEbs) {
        warnIndicatorFailure({
          failureCause: "ebs_signal_unconfigured",
          now: clock(),
          warn,
        });
      }
      return verdict;
    });
    await indicators.settle();
    if (Result.isError(result)) {
      const sqlState = getPgErrorCode(result.error);
      warnIndicatorFailure({
        failureCause: indicatorFailureCause(result.error),
        now: clock(),
        ...(sqlState === undefined ? {} : { sqlState }),
        warn,
      });
      return {
        kind: "unknown",
        signals: [
          {
            indicator: "long_transaction",
            kind: "unknown",
            value: null,
            threshold: null,
            observedAt: null,
            reason: "Database indicators are unavailable",
          },
        ],
      } as const satisfies Verdict;
    }
    return result.value;
  };
};

export const createScriptBackfillRuntime = ({
  db,
  slot: injectedSlot,
  ...options
}: RuntimeOptions & {
  db: {
    transaction: IngestionTransactionRunner<Transaction>;
    execute: (statement: SQL) => PromiseLike<unknown>;
  };
  slot?: DatabaseRuntimeOptions<Transaction>["slot"];
}) => {
  const slot = injectedSlot ?? {
    tryAcquire: async (tx: Transaction) =>
      await tryAcquireBackfillTransactionSlot({
        query: async (statement, parameters) =>
          (await drizzleQuery(tx)(statement, parameters)).map((row) => {
            if (!isRecord(row) || typeof row["acquired"] !== "boolean") {
              return panic("Invalid advisory lock response");
            }
            return { acquired: row["acquired"] };
          }),
      }),
    release: () => undefined,
  };
  return createRuntime({
    ...options,
    transactionQuery: (tx: Transaction) => drizzleQuery(tx),
    config: {
      ...(options.config ?? defaultConfig),
      minSize: Math.min(
        options.initialSize,
        (options.config ?? defaultConfig).minSize,
      ),
      maxSize: Math.max(
        options.initialSize,
        (options.config ?? defaultConfig).maxSize,
      ),
    },
    runInTransaction: db.transaction.bind(db),
    slot,
    close: async () => await Promise.resolve(),
  });
};

export const createBackfillRuntime = (
  options: RuntimeOptions & {
    connection: Pick<OnlineMigrationConnection, "execute" | "query">;
  },
) => {
  const { connection } = options;
  const slot = createHeavyWorkSlot({
    kind: "backfill_batch",
    session: {
      query: async (statement, parameters) =>
        (await connection.query(statement, parameters)).map((row) => {
          if (!isRecord(row) || typeof row["acquired"] !== "boolean") {
            return panic("Invalid advisory lock response");
          }
          return { acquired: row["acquired"] };
        }),
    },
  });
  const runInTransaction: IngestionTransactionRunner<
    Pick<OnlineMigrationConnection, "execute" | "query">
  > = async (work) => {
    await connection.execute("BEGIN");
    const outcome = await Result.tryPromise({
      try: async () => {
        const result = await work(connection);
        await connection.execute("COMMIT");
        return result;
      },
      catch: (cause: unknown) => cause,
    });
    if (Result.isOk(outcome)) {
      return outcome.value;
    }
    await connection.execute("ROLLBACK");
    throw outcome.error;
  };
  return createRuntime({
    ...options,
    slot: {
      tryAcquire: async () => {
        const acquisition = await slot.tryAcquire();
        if (acquisition.isErr()) {
          throw acquisition.error.cause;
        }
        return acquisition.value;
      },
      release: slot.release,
    },
    transactionQuery: (
      tx: Pick<OnlineMigrationConnection, "execute" | "query">,
    ) => tx.query,
    config: {
      ...(options.config ?? defaultConfig),
      minSize: Math.min(
        options.initialSize,
        (options.config ?? defaultConfig).minSize,
      ),
      maxSize: Math.max(
        options.initialSize,
        (options.config ?? defaultConfig).maxSize,
      ),
    },
    runInTransaction,
    close: slot.close,
  });
};
