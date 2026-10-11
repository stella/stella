import { panic, Result } from "better-result";
import type { ReservedSQL } from "bun";
import { eq, type SQLWrapper } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import {
  isHeldTooLong,
  nextBatch,
  type BatchState,
  type HealthConfig,
  type Verdict,
} from "@stll/db-load-gate/health";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { readReplayTickEnvironment } from "@/api/env-replay";
import type {
  SourceAdapter,
  StoredRawReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  BackgroundReplaySource,
  BackgroundReplayTickReport,
} from "@/api/handlers/case-law/ingestion/background-replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  REPLAY_HEALTH_CONFIG,
  replayKillRequested,
  type ReplayEnrolment,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import {
  classifyReplayFailure,
  replayFailure,
} from "@/api/handlers/case-law/ingestion/replay-failure";
import {
  enterCaseLawMaintenanceLane,
  createCaseLawMaintenanceCleanupHandles,
  type CaseLawRootHandle,
  type CaseLawScriptHandles,
} from "@/api/lib/case-law/maintenance-lane";
import type {
  CaseLawSourceIngestionLease,
  acquireCaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import { isLocalTestRun } from "@/api/runtime-mode";

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

const loadReplayCleanupHandles = async () =>
  await createCaseLawMaintenanceCleanupHandles({
    timeoutMs: CLEANUP_TIMEOUT_MS,
    queryTimeoutMs: REPLAY_QUERY_TIMEOUT_MS,
  });

const releaseReplayDb: ScopedDb = async (work) =>
  await (await loadReplayCleanupHandles()).ingestionDb(work);

const loadReplayTickRuntime = async () => {
  const [
    { withLongRunningConnection },
    { createScriptBackfillHealthReader },
    { createHeavyWorkSlot },
    { runBackgroundReplayTick },
    { createBackgroundReplayRunner },
    { createBackgroundReplayStore },
    { acquireCaseLawSourceIngestionLease },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/backfill-runtime"),
    import("@stll/db-load-gate/slot"),
    import("@/api/handlers/case-law/ingestion/background-replay"),
    import("@/api/handlers/case-law/ingestion/background-replay-runner"),
    import("@/api/handlers/case-law/ingestion/background-replay-store"),
    import("@/api/lib/legal-search/case-law-source-ingestion-lease"),
  ]);
  return {
    withLongRunningConnection,
    createScriptBackfillHealthReader,
    createHeavyWorkSlot,
    runBackgroundReplayTick,
    createBackgroundReplayRunner,
    createBackgroundReplayStore,
    acquireCaseLawSourceIngestionLease,
  };
};

const createReplayCleanupStore = async () => {
  const { createBackgroundReplayStore } =
    await import("@/api/handlers/case-law/ingestion/background-replay-store");
  const { rootDb } = await loadReplayCleanupHandles();
  return createBackgroundReplayStore({
    db: rootDb,
    now,
  });
};

const reportReplayTick = (report: BackgroundReplayTickReport) => {
  if (report.source) {
    metric(report.source, "case_law.replay.tick", {
      "case_law.replay.tick.applied": report.applied,
      "case_law.replay.tick.failed": Number(report.status === "failed"),
      "case_law.replay.tick.rows_failed": report.failed,
      "case_law.replay.tick.retry_exhausted": report.retryExhausted,
      "case_law.replay.tick.retry_terminal": report.retryTerminal,
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
  log({
    ...(report.source === null
      ? {
          _aws: {
            Timestamp: now(),
            CloudWatchMetrics: [
              {
                Namespace: "Stella/CaseLaw",
                Dimensions: [[]],
                Metrics: [
                  { Name: "case_law.replay.tick.held", Unit: "Count" },
                  { Name: "case_law.replay.tick.hold_too_long", Unit: "Count" },
                  { Name: "case_law.replay.tick.failed", Unit: "Count" },
                ],
              },
            ],
          },
          "case_law.replay.tick.held": Number(report.status === "held"),
          "case_law.replay.tick.hold_too_long": Number(report.heldTooLong),
          "case_law.replay.tick.failed": Number(report.status === "failed"),
        }
      : {}),
    event: "case_law.replay.tick",
    ...report,
  });
};

type ReplayPreflightGateOptions = {
  readVerdict: () => Promise<Verdict>;
  loadState: () => Promise<BatchState>;
  saveState: (state: BatchState) => Promise<void>;
  clock: () => number;
};

export const createReplayPreflightGate = ({
  readVerdict,
  loadState,
  saveState,
  clock,
}: ReplayPreflightGateOptions) => {
  let state: BatchState | undefined;
  return {
    heldTooLong: () => state !== undefined && isHeldTooLong(state, clock()),
    readVerdict: async (): Promise<Verdict> => {
      state ??= await loadState();
      if (state.holdUntil !== null && clock() < state.holdUntil) {
        return { kind: "unknown", signals: [] };
      }
      const verdict = await readVerdict();
      const recovering = state.heldSince !== null;
      const plan = nextBatch({
        state,
        verdict,
        lastDurationMs: null,
        config: REPLAY_HEALTH_CONFIG,
        clock,
      });
      state = plan.state;
      if (plan.action === "hold" || recovering) {
        await saveState(state);
      }
      return plan.action === "hold"
        ? { kind: "unknown", signals: [] }
        : verdict;
    },
  };
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

type ReplayTickRuntimeOptions = {
  enrolment?: Readonly<Record<AdapterKey, ReplayEnrolment>>;
  adapterFor?: (key: string) => SourceAdapter | undefined;
  readStoredRaw?: StoredRawReader;
  gate?: () => Promise<Verdict>;
  healthConfig?: Pick<HealthConfig, "busyWindows">;
  maxRows?: number;
  onIngestionTransaction?: (tx: Transaction) => Promise<void>;
  onRootTransaction?: (tx: Transaction) => Promise<void>;
};

type ReplayTickRuntime = Awaited<ReturnType<typeof loadReplayTickRuntime>>;

type ReplaySessionHandlesOptions = {
  handles: CaseLawScriptHandles;
  fixture: ReplayTickRuntimeOptions;
};

const observeReplaySessionHandles = ({
  handles,
  fixture,
}: ReplaySessionHandlesOptions) => {
  const transaction: CaseLawRootHandle["transaction"] = async (work) =>
    await handles.rootDb.transaction(async (tx) => {
      await fixture.onRootTransaction?.(tx);
      return await work(tx);
    });
  const rootDb: CaseLawRootHandle = {
    transaction,
    execute: async <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) => await transaction(async (tx) => await tx.execute<TRow>(query)),
  };
  const ingestionDb: ScopedDb = async (work) =>
    await handles.ingestionDb(async (tx) => {
      await fixture.onIngestionTransaction?.(tx);
      return await work(tx);
    });
  return { rootDb, ingestionDb };
};

const persistReplayTickReport = async (
  tickReport: BackgroundReplayTickReport,
  cleanupStore: Awaited<ReturnType<typeof createReplayCleanupStore>>,
) => {
  const progress = await cleanupStore.recordTick(tickReport);
  if (tickReport.source !== null && progress !== null) {
    metric(tickReport.source, "case_law.replay.progress", {
      "case_law.replay.tick.ticks_without_progress":
        progress.ticksWithoutProgress,
      "case_law.replay.tick.no_progress_while_lagging": Number(
        tickReport.source.rowsBehind > 0 && progress.ticksWithoutProgress > 0,
      ),
    });
  }
  const compacted = await Result.tryPromise(
    async () => await cleanupStore.compact(),
  );
  if (compacted.isErr()) {
    log({
      event: "case_law.replay.compaction_deferred",
      ...classifyReplayFailure(compacted.error),
    });
  }
  return tickReport;
};

type ReplaySlotSessionOptions = {
  connection: ReservedSQL;
  runtime: ReplayTickRuntime;
  rootDb: CaseLawRootHandle;
  ingestionDb: ScopedDb;
  signal: AbortSignal;
  fixture: ReplayTickRuntimeOptions;
};

const runReplayOnSlotSession = async ({
  connection,
  runtime,
  rootDb,
  ingestionDb,
  signal,
  fixture,
}: ReplaySlotSessionOptions): Promise<BackgroundReplayTickReport> => {
  const lockBackend = (
    await connection.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
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
    config: { ...REPLAY_HEALTH_CONFIG, ...fixture.healthConfig },
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
    ...(fixture.enrolment === undefined
      ? {}
      : { enrolment: fixture.enrolment }),
    sourceEnabled: (key) => !replayKillRequested(key),
    onBudgetExhausted: (source) =>
      metric(source, "case_law.replay.tick", {
        "case_law.replay.tick.budget_exhausted": 1,
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
    ...(fixture.adapterFor === undefined
      ? {}
      : { adapterFor: fixture.adapterFor }),
    ...(fixture.readStoredRaw === undefined
      ? {}
      : { readStoredRaw: fixture.readStoredRaw }),
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
  const observation: {
    source: BackgroundReplaySource | null;
    report: BackgroundReplayTickReport | null;
  } = { source: null, report: null };
  const preflight = createReplayPreflightGate({
    readVerdict: async () =>
      fixture.gate === undefined
        ? await readReplayGate(health)
        : await fixture.gate(),
    loadState: cleanupStore.loadPreflightGateState,
    saveState: cleanupStore.savePreflightGateState,
    clock: now,
  });
  try {
    const attempted = await Result.tryPromise(async () => {
      signal.throwIfAborted();
      const tickReport = await runtime.runBackgroundReplayTick({
        ...BACKGROUND_REPLAY_LIMITS,
        ...(fixture.maxRows === undefined ? {} : { maxRows: fixture.maxRows }),
        signal,
        dependencies: {
          ...store,
          chooseSource: async () => {
            observation.source = await store.chooseSource();
            return observation.source;
          },
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
            lastVerdict = await preflight.readVerdict();
            signal.throwIfAborted();
            return lastVerdict;
          },
          ...runner,
          metric: (report) => {
            if (report.source === null && report.status === "held") {
              report.heldTooLong = preflight.heldTooLong();
            }
            observation.report = report;
            reportReplayTick(report);
          },
          now,
          sleep: async (milliseconds) => {
            await sleep(milliseconds, undefined, { signal });
          },
        },
      });
      return tickReport;
    });
    const tickReport: BackgroundReplayTickReport = attempted.isOk()
      ? attempted.value
      : {
          status: "failed",
          source: observation.source,
          attempted: observation.report?.attempted ?? 0,
          applied: observation.report?.applied ?? 0,
          blocked: observation.report?.blocked ?? 0,
          errors: (observation.report?.errors ?? 0) + 1,
          failed: observation.report?.failed ?? 0,
          retryExhausted: observation.report?.retryExhausted ?? 0,
          retryTerminal: observation.report?.retryTerminal ?? 0,
          heldTooLong: preflight.heldTooLong(),
        };
    if (attempted.isErr()) {
      reportReplayTick(tickReport);
      log({
        event: "case_law.replay.tick_failure",
        sourceId: observation.source?.id ?? null,
        ...classifyReplayFailure(attempted.error),
      });
    }
    return await persistReplayTickReport(tickReport, cleanupStore);
  } finally {
    try {
      await health.settle();
    } finally {
      await slot.close();
    }
  }
};

/** A bounded scheduled invocation: no waiting for leases, slots or health holds. */
const runReplayTickWithOptions = async (
  signal: AbortSignal,
  fixture: ReplayTickRuntimeOptions,
): Promise<BackgroundReplayTickReport | null> => {
  signal.throwIfAborted();
  const runtime = await loadReplayTickRuntime();
  signal.throwIfAborted();
  const report = await enterCaseLawMaintenanceLane({
    mode: "bounded",
    statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
    lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
    signal,
    work: async (handles) => {
      const { rootDb, ingestionDb } = observeReplaySessionHandles({
        handles,
        fixture,
      });
      return await runtime.withLongRunningConnection(
        {
          statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
          lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
          signal,
        },
        async ({ connection }) =>
          await runReplayOnSlotSession({
            connection,
            runtime,
            rootDb,
            ingestionDb,
            signal,
            fixture,
          }),
      );
    },
  });
  if (report === null) {
    log({ event: "case_law.replay.tick", status: "maintenance-held" });
  }
  return report;
};

export const runEnabledReplayTick = async (signal: AbortSignal) =>
  await runReplayTickWithOptions(signal, {});

/** Refuse fixture access before loading any database or storage runtime. */
export const getReplayTickFixtureRunner = () => {
  if (!isLocalTestRun()) {
    return panic("Replay tick fixtures require a local test run");
  }
  return async (signal: AbortSignal, options: ReplayTickRuntimeOptions) => {
    if (!isLocalTestRun()) {
      return panic("Replay tick fixtures require a local test run");
    }
    return await runReplayTickWithOptions(signal, options);
  };
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
  const { createBackgroundReplayStore } =
    await import("@/api/handlers/case-law/ingestion/background-replay-store");
  const { caseLawSources } = await import("@/api/db/schema");
  signal.throwIfAborted();
  const reset = await enterCaseLawMaintenanceLane({
    mode: "bounded",
    statementTimeout: REPLAY_QUERY_TIMEOUT_MS,
    lockTimeout: REPLAY_QUERY_TIMEOUT_MS,
    signal,
    work: async (handles) => {
      const transaction: CaseLawRootHandle["transaction"] = async (work) =>
        await handles.rootDb.transaction(async (tx) => {
          signal.throwIfAborted();
          if (replayKillRequested(adapterKey)) {
            panic("Replay dry-run reset was disabled before database work");
          }
          const result = await work(tx);
          signal.throwIfAborted();
          return result;
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
  });
  return reset ?? false;
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
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}: RunReplayTickScriptOptions = {}): Promise<number> => {
  const signal = timeoutSignal(BACKGROUND_REPLAY_LIMITS.hardDurationMs);
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
      if (resetPolicy?.mode !== "dry-run") {
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
    return report?.status === "failed" ? 1 : 0;
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
  await runScriptWithErrorOutput(async () => {
    process.exit(await runReplayTickScript());
  });
}
