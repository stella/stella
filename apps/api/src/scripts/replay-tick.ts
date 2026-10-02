import { panic, Result } from "better-result";
import { eq, sql, type SQLWrapper } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import { isHeldTooLong, type Verdict } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { readReplayTickEnvironment } from "@/api/env-replay";
import type {
  BackgroundReplaySource,
  BackgroundReplayTickReport,
} from "@/api/handlers/case-law/ingestion/background-replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  replayKillRequested,
  type ReplayEnrolment,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import {
  classifyReplayFailure,
  replayFailure,
} from "@/api/handlers/case-law/ingestion/replay-failure";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import type {
  CaseLawSourceIngestionLease,
  acquireCaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

const now = () => Temporal.Now.instant().epochMilliseconds;
const log = (record: unknown) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
type ReplayTickMetricOptions = {
  source: BackgroundReplaySource;
  event: string;
  values: Record<string, number>;
  timestamp: number;
};

export const replayTickMetricRecord = ({
  source,
  event,
  values,
  timestamp,
}: ReplayTickMetricOptions) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: "Stella/CaseLaw",
        Dimensions: [["AdapterKey", "SourceId", "Mode"]],
        Metrics: Object.keys(values).map((Name) => ({
          Name,
          Unit: Name.endsWith("oldest_age_ms") ? "Milliseconds" : "Count",
        })),
      },
    ],
  },
  event,
  AdapterKey: source.adapterKey,
  SourceId: source.id,
  Mode: source.mode,
  ...values,
});

const metric = (
  source: BackgroundReplaySource,
  event: string,
  values: Record<string, number>,
) => {
  log(replayTickMetricRecord({ source, event, values, timestamp: now() }));
};

type AssertReplaySlotOptions = {
  queryBackend: () => Promise<number | undefined>;
  expectedBackend: number;
  signal: AbortSignal;
};

export const assertReplaySlot = async ({
  queryBackend,
  expectedBackend,
  signal,
}: AssertReplaySlotOptions) => {
  signal.throwIfAborted();
  const current = await queryBackend();
  signal.throwIfAborted();
  if (current !== expectedBackend) {
    panic("Heavy-work session was replaced; replay must stop");
  }
};

type ReadReplayGateOptions = {
  readVerdict: () => Promise<Verdict>;
  settle: () => Promise<void>;
};

export const readReplayGate = async ({
  readVerdict,
  settle,
}: ReadReplayGateOptions): Promise<Verdict> => {
  const result = await Result.tryPromise(readVerdict);
  await settle();
  return result.isOk() ? result.value : { kind: "unknown", signals: [] };
};

const CLEANUP_TIMEOUT_MS = 30_000;
const REPLAY_QUERY_TIMEOUT_MS = 5000;

/** Cleanup retries the schema lane outside transactions on its own connection. */
const cleanupReplayTransaction: CaseLawRootHandle["transaction"] = async (
  work,
) => {
  const [{ withLongRunningConnection }, { runUnderCorpusSchemaLane }] =
    await Promise.all([
      import("@/api/db/long-running-connection"),
      import("@/api/db/corpus-schema-lane"),
    ]);
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  return await withLongRunningConnection(
    {
      statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
      lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
      signal,
    },
    async ({ db }) =>
      await runUnderCorpusSchemaLane({
        database: db,
        laneWaitMs: CLEANUP_TIMEOUT_MS,
        sleep: async (milliseconds) =>
          await sleep(milliseconds, undefined, { signal }),
        work: async (tx) => {
          signal.throwIfAborted();
          return await work(tx);
        },
      }),
  );
};

const releaseReplayDb: ScopedDb = async (work) =>
  await cleanupReplayTransaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    return await work(tx);
  });

const loadReplayTickRuntime = async () => {
  const [
    { withLongRunningConnection },
    { runUnderCorpusSchemaLane },
    { createScriptBackfillHealthReader },
    { createHeavyWorkSlot },
    { runBackgroundReplayTick },
    { createBackgroundReplayRunner },
    { createBackgroundReplayStore },
    { acquireCaseLawSourceIngestionLease },
    { CASE_LAW_MAINTENANCE_LANE },
    { refreshS3, refreshCorpusS3 },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/corpus-schema-lane"),
    import("@/api/db/backfill-runtime"),
    import("@stll/db-load-gate/slot"),
    import("@/api/handlers/case-law/ingestion/background-replay"),
    import("@/api/handlers/case-law/ingestion/background-replay-runner"),
    import("@/api/handlers/case-law/ingestion/background-replay-store"),
    import("@/api/lib/legal-search/case-law-source-ingestion-lease"),
    import("@/api/lib/case-law/maintenance-lane"),
    import("@/api/lib/s3"),
  ]);
  return {
    withLongRunningConnection,
    runUnderCorpusSchemaLane,
    createScriptBackfillHealthReader,
    createHeavyWorkSlot,
    runBackgroundReplayTick,
    createBackgroundReplayRunner,
    createBackgroundReplayStore,
    acquireCaseLawSourceIngestionLease,
    CASE_LAW_MAINTENANCE_LANE,
    refreshS3,
    refreshCorpusS3,
  };
};

const createReplayCleanupStore = async () => {
  const { createBackgroundReplayStore } =
    await import("@/api/handlers/case-law/ingestion/background-replay-store");
  const cleanupRootDb: CaseLawRootHandle = {
    transaction: cleanupReplayTransaction,
    execute: async <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) =>
      await cleanupReplayTransaction(
        async (tx) => await tx.execute<TRow>(query),
      ),
  };
  return createBackgroundReplayStore({
    db: cleanupRootDb,
    now,
  });
};

const reportReplayTick = (report: BackgroundReplayTickReport) => {
  if (report.source) {
    metric(report.source, "case_law.replay.tick", {
      "case_law.replay.tick.applied": report.applied,
      "case_law.replay.tick.failed": Number(report.errors > 0),
      "case_law.replay.tick.rows_failed": report.failed,
      "case_law.replay.tick.hold_too_long": Number(report.heldTooLong),
      "case_law.replay.tick.blocked": report.blocked,
      "case_law.replay.tick.held": Number(
        report.status === "held" ||
          report.status === "slot-unavailable" ||
          report.status === "lease-unavailable",
      ),
      "case_law.replay.tick.budget_exhausted": Number(
        report.status === "budget-exhausted",
      ),
    });
  }
  log({ event: "case_law.replay.tick", ...report });
};

type ReplayLeaseOwnerOptions = {
  acquire: typeof acquireCaseLawSourceIngestionLease;
  scopedDb: ScopedDb;
};

const createReplayLeaseOwner = ({
  acquire,
  scopedDb,
}: ReplayLeaseOwnerOptions) => {
  let lease: CaseLawSourceIngestionLease | null = null;
  return {
    getLease: () => lease,
    acquireLease: async (source: BackgroundReplaySource) => {
      lease = await acquire({
        scopedDb,
        sourceId: source.id,
        releaseDb: releaseReplayDb,
      });
      if (lease === null) {
        return null;
      }
      const claimed = lease;
      return async () => {
        await claimed.release();
        lease = null;
      };
    },
  };
};

/** A bounded scheduled invocation: no waiting for leases, slots or health holds. */
const runEnabledReplayTick = async (
  signal: AbortSignal,
): Promise<BackgroundReplayTickReport | null> => {
  signal.throwIfAborted();
  const runtime = await loadReplayTickRuntime();
  signal.throwIfAborted();
  return await runtime.withLongRunningConnection(
    {
      statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
      lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
      signal,
    },
    async ({ db, connection: maintenanceConnection }) => {
      const acquired = (
        await maintenanceConnection.unsafe<{ acquired: boolean }[]>(
          "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
          [
            runtime.CASE_LAW_MAINTENANCE_LANE.domain,
            runtime.CASE_LAW_MAINTENANCE_LANE.lane,
          ],
        )
      ).at(0)?.acquired;
      if (acquired !== true) {
        log({ event: "case_law.replay.tick", status: "maintenance-held" });
        return null;
      }
      const transaction: CaseLawRootHandle["transaction"] = async (work) => {
        signal.throwIfAborted();
        return await runtime.runUnderCorpusSchemaLane({
          database: db,
          laneWaitMs: 0,
          work: async (tx) => {
            signal.throwIfAborted();
            const result = await work(tx);
            signal.throwIfAborted();
            return result;
          },
        });
      };
      const rootDb: CaseLawRootHandle = {
        transaction,
        execute: async <TRow extends Record<string, unknown>>(
          query: SQLWrapper | string,
        ) => await transaction(async (tx) => await tx.execute<TRow>(query)),
      };
      const ingestionDb: ScopedDb = async (work) =>
        await transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          return await work(tx);
        });
      return await runtime.withLongRunningConnection(
        {
          statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
          lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
          signal,
        },
        async ({ connection }) => {
          const lockBackend = (
            await connection.unsafe<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).at(0)?.pid;
          if (lockBackend === undefined) {
            panic("Heavy-work session returned no backend identity");
          }
          const slot = runtime.createHeavyWorkSlot({
            kind: "backfill_batch",
            session: {
              query: async (statement, parameters) => {
                const rows = await connection.unsafe<{ acquired: boolean }[]>(
                  statement,
                  [...parameters],
                );
                return rows;
              },
            },
          });
          const health = runtime.createScriptBackfillHealthReader({
            db: rootDb,
            tableName: "case_law_decisions",
            clock: now,
          });
          let lastVerdict: Verdict = { kind: "unknown", signals: [] };
          const leaseOwner = createReplayLeaseOwner({
            acquire: runtime.acquireCaseLawSourceIngestionLease,
            scopedDb: ingestionDb,
          });
          const cleanupStore = await createReplayCleanupStore();
          const store = runtime.createBackgroundReplayStore({
            db: rootDb,
            now,
            sourceEnabled: (key) => !replayKillRequested(key),
            onBudgetExhausted: (source) =>
              metric(source, "case_law.replay.tick", {
                "case_law.replay.tick.budget_exhausted": 1,
              }),
            onLag: (source) =>
              metric(source, "case_law.replay.lag", {
                "case_law.replay.lag.sampled_rows_behind": source.rowsBehind,
              }),
            onHeld: (source, state) =>
              metric(source, "case_law.replay.tick", {
                "case_law.replay.tick.held": 1,
                "case_law.replay.tick.hold_too_long": Number(
                  isHeldTooLong(state, now()),
                ),
              }),
          });
          const runner = runtime.createBackgroundReplayRunner({
            rootDb,
            ingestionDb,
            getLease: leaseOwner.getLease,
            signal,
            recordFailure: cleanupStore.recordFailure,
            assertSlot: async () =>
              await assertReplaySlot({
                expectedBackend: lockBackend,
                signal,
                queryBackend: async () =>
                  (
                    await connection.unsafe<{ pid: number }[]>(
                      "SELECT pg_backend_pid() AS pid",
                    )
                  ).at(0)?.pid,
              }),
            store,
            log,
          });
          try {
            signal.throwIfAborted();
            await runtime.refreshS3(signal);
            signal.throwIfAborted();
            await runtime.refreshCorpusS3(signal);
            signal.throwIfAborted();
            const tickReport = await runtime.runBackgroundReplayTick({
              ...BACKGROUND_REPLAY_LIMITS,
              signal,
              dependencies: {
                ...store,
                killRequested: async (source) =>
                  await Promise.resolve(replayKillRequested(source.adapterKey)),
                reserveBatch: async (source, day) =>
                  await store.reserveBatch(source, day, lastVerdict),
                acquireLease: leaseOwner.acquireLease,
                acquireHeavySlot: async () => {
                  const slotAttempt = await slot.tryAcquire();
                  if (slotAttempt.isErr()) {
                    throw slotAttempt.error;
                  }
                  return slotAttempt.value ? slot.release : null;
                },
                gate: async () => {
                  signal.throwIfAborted();
                  lastVerdict = await readReplayGate(health);
                  signal.throwIfAborted();
                  return lastVerdict;
                },
                ...runner,
                metric: reportReplayTick,
                now,
                sleep: async (milliseconds) => {
                  await sleep(milliseconds, undefined, { signal });
                },
              },
            });
            const progress = await cleanupStore.recordTick(tickReport);
            if (tickReport.source !== null && progress !== null) {
              metric(tickReport.source, "case_law.replay.progress", {
                "case_law.replay.tick.ticks_without_progress":
                  progress.ticksWithoutProgress,
                "case_law.replay.tick.no_progress_while_lagging": Number(
                  tickReport.source.rowsBehind > 0 &&
                    progress.ticksWithoutProgress > 0,
                ),
              });
            }
            await cleanupStore.compact();
            return tickReport;
          } finally {
            try {
              await health.settle();
            } finally {
              await slot.close();
            }
          }
        },
      );
    },
  );
};

type ResetReplayDryRunOptions = {
  adapterKey: AdapterKey;
  policy: Extract<ReplayEnrolment, { mode: "dry-run" }>;
  signal: AbortSignal;
};

/** Reset owns only preview progress, under the same maintenance/schema lanes. */
const resetReplayDryRun = async ({
  adapterKey,
  policy,
  signal,
}: ResetReplayDryRunOptions): Promise<boolean> => {
  signal.throwIfAborted();
  const [
    { withLongRunningConnection },
    { runUnderCorpusSchemaLane },
    { CASE_LAW_MAINTENANCE_LANE },
    { createBackgroundReplayStore },
    { caseLawSources },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/corpus-schema-lane"),
    import("@/api/lib/case-law/maintenance-lane"),
    import("@/api/handlers/case-law/ingestion/background-replay-store"),
    import("@/api/db/schema"),
  ]);
  signal.throwIfAborted();
  return await withLongRunningConnection(
    {
      statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
      lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
      signal,
    },
    async ({ db, connection }) => {
      const acquired = (
        await connection.unsafe<{ acquired: boolean }[]>(
          "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
          [CASE_LAW_MAINTENANCE_LANE.domain, CASE_LAW_MAINTENANCE_LANE.lane],
        )
      ).at(0)?.acquired;
      if (acquired !== true) {
        return false;
      }
      const transaction: CaseLawRootHandle["transaction"] = async (work) =>
        await runUnderCorpusSchemaLane({
          database: db,
          laneWaitMs: 0,
          work: async (tx) => {
            signal.throwIfAborted();
            if (replayKillRequested(adapterKey)) {
              panic("Replay dry-run reset was disabled before database work");
            }
            const result = await work(tx);
            signal.throwIfAborted();
            return result;
          },
        });
      const rootDb: CaseLawRootHandle = {
        transaction,
        execute: async <TRow extends Record<string, unknown>>(
          query: SQLWrapper | string,
        ) => await transaction(async (tx) => await tx.execute<TRow>(query)),
      };
      const source = await transaction(async (tx) =>
        (
          await tx
            .select({ id: caseLawSources.id })
            .from(caseLawSources)
            .where(eq(caseLawSources.adapterKey, adapterKey))
            .limit(1)
        ).at(0),
      );
      if (source === undefined) {
        panic("Replay dry-run reset requires an existing source");
      }
      await createBackgroundReplayStore({ db: rootDb, now }).resetDryRunCursor({
        id: source.id,
        adapterKey,
        currentParserVersion: PARSER_VERSIONS[adapterKey],
        dailyBudget: policy.dailyBudget,
        mode: "dry-run",
        rowsBehind: 0,
      });
      return true;
    },
  );
};

const parseReplayTickCommand = (args: readonly string[]) => {
  if (args.length === 0) {
    return { type: "tick" } as const;
  }
  const key = args.at(1);
  const adapterKey = Object.values(ADAPTER_KEYS).find((value) => value === key);
  if (
    args.length !== 2 ||
    args.at(0) !== "--reset-dry-run" ||
    adapterKey === undefined
  ) {
    panic("Replay accepts only --reset-dry-run <adapter-key> or no arguments");
  }
  return { type: "reset-dry-run", adapterKey } as const;
};

type RunReplayTickScriptOptions = {
  args?: readonly string[];
  environment?: ReturnType<typeof readReplayTickEnvironment>;
  policies?: readonly ReplayEnrolment[];
  enrolment?: Readonly<Record<AdapterKey, ReplayEnrolment>>;
  resetDryRun?: (options: ResetReplayDryRunOptions) => Promise<boolean>;
  runEnabled?: (
    signal: AbortSignal,
  ) => Promise<BackgroundReplayTickReport | null>;
  log?: (record: unknown) => void;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
};

export const runReplayTickScript = async ({
  args = process.argv.slice(2),
  environment = readReplayTickEnvironment(),
  policies = Object.values(REPLAY_ENROLMENT),
  enrolment = REPLAY_ENROLMENT,
  resetDryRun = resetReplayDryRun,
  runEnabled = runEnabledReplayTick,
  log: writeLog = log,
  timeoutSignal = AbortSignal.timeout,
}: RunReplayTickScriptOptions = {}): Promise<number> => {
  const signal = timeoutSignal(BACKGROUND_REPLAY_LIMITS.maxDurationMs);
  const outcome = await Result.tryPromise(async () => {
    const command = parseReplayTickCommand(args);
    const resetPolicy =
      command.type === "reset-dry-run" ? enrolment[command.adapterKey] : null;
    if (resetPolicy !== null && resetPolicy.mode !== "dry-run") {
      panic("Replay cursor reset requires reviewed dry-run enrolment");
    }
    if (
      !environment.CASE_LAW_REPLAY_ENABLED ||
      environment.CASE_LAW_REPLAY_KILL_SWITCH ||
      (command.type === "tick" &&
        policies.every((policy) => policy.mode === "off")) ||
      (command.type === "reset-dry-run" &&
        environment.CASE_LAW_REPLAY_DISABLED_SOURCES.split(",").some(
          (key) => key.trim() === command.adapterKey,
        ))
    ) {
      writeLog({ event: "case_law.replay.tick", status: "disabled" });
      return 0;
    }
    signal.throwIfAborted();
    if (command.type === "reset-dry-run") {
      if (resetPolicy === null || resetPolicy.mode !== "dry-run") {
        panic("Replay reset command has no dry-run policy");
      }
      const reset = await resetDryRun({
        adapterKey: command.adapterKey,
        policy: resetPolicy,
        signal,
      });
      signal.throwIfAborted();
      writeLog({
        event: "case_law.replay.dry_run_reset",
        adapterKey: command.adapterKey,
        status: reset ? "complete" : "maintenance-held",
      });
      return 0;
    }
    const report = await runEnabled(signal);
    signal.throwIfAborted();
    return report !== null &&
      (report.errors > 0 ||
        report.status === "failed" ||
        report.status === "error-ceiling" ||
        report.status === "retryable")
      ? 1
      : 0;
  });
  if (outcome.isOk()) {
    return outcome.value;
  }
  writeLog({
    _aws: {
      Timestamp: now(),
      CloudWatchMetrics: [
        {
          Namespace: "Stella/CaseLaw",
          Dimensions: [[]],
          Metrics: [{ Name: "case_law.replay.tick.failed", Unit: "Count" }],
        },
      ],
    },
    "case_law.replay.tick.failed": 1,
    event: "case_law.replay.tick",
    status: "failed",
    ...(signal.aborted
      ? replayFailure("tick-deadline")
      : classifyReplayFailure(outcome.error)),
  });
  return 1;
};

if (import.meta.main) {
  process.exit(await runReplayTickScript());
}
