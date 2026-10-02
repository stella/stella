import { panic, Result } from "better-result";
import { sql, type SQL } from "drizzle-orm";

import { BackfillHeldError } from "@stll/db-load-gate/backfill-pass";
import {
  combine,
  defaultConfig,
  initialBatchState,
} from "@stll/db-load-gate/health";
import type { HealthConfig, Signal, Verdict } from "@stll/db-load-gate/health";
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

import { logger } from "@/api/lib/observability/logger";
import { getPgErrorCode } from "@/api/lib/pg-error";

import {
  createEbsSignalReader,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";
import { executedRows } from "../lib/db/executed-rows";
import { isPgError, PG_ERROR } from "../lib/pg-error";
import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";
import { isRecord } from "../lib/type-guards";
import { runAdaptiveBackfillBatch } from "./adaptive-backfill";
import { createBoundedIndicatorQuery } from "./indicator-query";
import type { IndicatorQuery } from "./indicator-query";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import type { Transaction } from "./root";
import { setSharedQueryTimeouts } from "./shared-pool-timeouts";

export { BackfillHeldError } from "@stll/db-load-gate/backfill-pass";

type Query = IndicatorQuery;
type RuntimeOptions = {
  name: string;
  tableName: string;
  initialSize: number;
  config?: HealthConfig | undefined;
  clock?: (() => number) | undefined;
  readVerdict?: (() => Promise<Verdict>) | undefined;
  log?: ((record: unknown) => void) | undefined;
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

const decodeCheckpoint = (row: unknown) => {
  if (!isRecord(row) || !isRecord(row["batch"])) {
    return panic("Invalid backfill checkpoint");
  }
  const b = row["batch"];
  const cursor = row["cursor"];
  if (
    !(cursor === null || typeof cursor === "string") ||
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
  return {
    cursor,
    batch: {
      size: b["size"],
      sleepMs: b["sleepMs"],
      stableBatches: b["stableBatches"],
      holdCount: b["holdCount"],
      smoothedDurationMs: b["smoothedDurationMs"],
      heldSince: b["heldSince"],
      holdUntil: b["holdUntil"],
    },
  };
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

const createRuntime = <BatchTransaction>({
  name,
  tableName,
  initialSize,
  runInTransaction,
  transactionQuery,
  slot,
  close,
  config = defaultConfig,
  clock = () => Temporal.Now.instant().epochMilliseconds,
  readVerdict,
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
  const step = async <Value>(work: BatchWork<BatchTransaction, Value>) => {
    const completion: { result?: { value: Value } } = {};
    const result = await runAdaptiveBackfillBatch({
      runInTransaction,
      config,
      clock,
      log,
      readVerdict: readSettledVerdict,
      slot,
      readCheckpoint: async (tx) => {
        const q = transactionQuery(tx);
        await setSharedQueryTimeouts(q, {
          statementTimeoutMs: config.batchStatementTimeoutMs,
          lockTimeoutMs: config.batchLockTimeoutMs,
        });
        await q(
          "INSERT INTO database_backfill_states (name, batch) VALUES ($1, $2::text::jsonb) ON CONFLICT (name) DO NOTHING",
          [
            name,
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
      },
      persistCheckpoint: async (tx, checkpoint) => {
        await transactionQuery(tx)(
          "UPDATE database_backfill_states SET cursor = $2, batch = $3::text::jsonb, updated_at = now() WHERE name = $1",
          [name, checkpoint.cursor, JSON.stringify(checkpoint.batch)],
        );
      },
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
    if (result.status === "held" || result.status === "retry") {
      throw new BackfillHeldError({
        message: `Backfill ${name} deferred (${result.status})`,
        holdUntil: result.checkpoint.batch.holdUntil,
        heldSince: result.checkpoint.batch.heldSince,
      });
    }
    if (completion.result === undefined) {
      return panic("Backfill batch completed without a result");
    }
    return {
      done: result.status === "done",
      cursor: result.checkpoint.cursor,
      sleepMs: result.checkpoint.batch.sleepMs,
      value: completion.result.value,
    };
  };
  return { step, close };
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

const INDICATOR_WARNING_INTERVAL_MS = 10 * 60_000;
const indicatorWarnings = new Map<string, number>();

type IndicatorFailureCause =
  | "function_missing"
  | "execute_denied"
  | "owner_lacks_visibility"
  | "target_access_denied"
  | "ebs_signal_unconfigured"
  | "read_error";

const warnIndicatorFailure = (
  failureCause: IndicatorFailureCause,
  now: number,
  sqlState?: string,
) => {
  const previous = indicatorWarnings.get(failureCause);
  if (
    previous !== undefined &&
    now - previous < INDICATOR_WARNING_INTERVAL_MS
  ) {
    return;
  }
  indicatorWarnings.set(failureCause, now);
  logger.warn("database_load_gate.indicators_unavailable", {
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
  db: { transaction: IngestionTransactionRunner<Transaction> };
  tableName: string;
  config?: HealthConfig;
  clock?: () => number;
};

/** The database owns the aggregate indicator boundary; unavailable reads hold. */
export const createDatabaseLoadVerdictReader = ({
  db,
  tableName,
  config = defaultConfig,
  clock = () => Temporal.Now.instant().epochMilliseconds,
}: DatabaseLoadVerdictReaderOptions) => {
  const sharedReadEbsSignal = createCachedEbsSignalReader({ clock, config });
  const indicators = createBoundedIndicatorQuery({
    runInTransaction: db.transaction.bind(db),
    transactionQuery: (tx: Transaction) => drizzleQuery(tx),
    readTimeoutMs: config.readTimeoutMs,
  });
  return async () => {
    const result = await Result.tryPromise(async () => {
      const snapshot = await indicators.query(
        `SELECT transaction_age_ms AS "ageMs", vacuum_active AS active,
          pg_catalog.to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
         FROM public.stella_database_load_indicators($1::regclass)`,
        [tableName.includes(".") ? tableName : `public.${tableName}`],
      );
      const row = snapshot.at(0);
      if (
        !isRecord(row) ||
        typeof row["ageMs"] !== "number" ||
        typeof row["active"] !== "boolean" ||
        typeof row["observedAt"] !== "string"
      ) {
        warnIndicatorFailure("read_error", clock());
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
        query: async () => snapshot,
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
        warnIndicatorFailure("ebs_signal_unconfigured", clock());
      }
      return verdict;
    });
    await indicators.settle();
    if (Result.isError(result)) {
      warnIndicatorFailure(
        indicatorFailureCause(result.error),
        clock(),
        getPgErrorCode(result.error),
      );
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
  ...options
}: RuntimeOptions & {
  db: {
    transaction: IngestionTransactionRunner<Transaction>;
    execute: (statement: SQL) => PromiseLike<unknown>;
  };
}) => {
  const slot = {
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
  options: RuntimeOptions & { connection: OnlineMigrationConnection },
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
    OnlineMigrationConnection
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
    transactionQuery: (tx: OnlineMigrationConnection) => tx.query,
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
