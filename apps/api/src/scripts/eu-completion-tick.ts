import { panic, Result } from "better-result";
import type { ReservedSQL } from "bun";
import { eq } from "drizzle-orm";

import type { HealthConfig, Verdict } from "@stll/db-load-gate/health";
import { runScriptWithErrorOutput } from "@stll/errors";
import { Temporal } from "@stll/time";

import { readEuCompletionTickEnvironment } from "@/api/env-eu-completion";
import {
  EU_COMPLETION_LIMITS,
  EuCompletionStop,
  type EuCompletionReport,
} from "@/api/handlers/case-law/ingestion/eu-completion";
import { REPLAY_HEALTH_CONFIG } from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { classifyReplayFailure } from "@/api/handlers/case-law/ingestion/replay-failure";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createCaseLawMaintenanceCleanupHandles,
  enterCaseLawMaintenanceLane,
  type CaseLawScriptHandles,
} from "@/api/lib/case-law/maintenance-lane";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { isLocalTestRun } from "@/api/runtime-mode";
import {
  assertReplaySlot,
  createReplayPreflightGate,
  readReplayGate,
} from "@/api/scripts/replay-tick";

const QUERY_TIMEOUT_MS = 5000;
const CLEANUP_TIMEOUT_MS = 30_000;
const now = () => Temporal.Now.instant().epochMilliseconds;
const log = (record: unknown) =>
  process.stdout.write(`${JSON.stringify(record)}\n`);

type CompletionMetricOptions = {
  report: EuCompletionReport;
  mode: "dry-run" | "apply";
  enabled: boolean;
  timestamp: number;
};

export const euCompletionMetricRecord = ({
  report,
  mode,
  enabled,
  timestamp,
}: CompletionMetricOptions) => {
  const values = {
    "case_law.eu_completion.enabled": Number(
      enabled && report.status !== "off",
    ),
    "case_law.eu_completion.held": Number(report.status === "held"),
    "case_law.eu_completion.approval_required": Number(
      report.status === "approval-required",
    ),
    "case_law.eu_completion.attempted": report.attempted,
    "case_law.eu_completion.applied": report.applied,
    "case_law.eu_completion.unchanged": report.unchanged,
    "case_law.eu_completion.review_required": report.reviewRequired,
    "case_law.eu_completion.retries": report.retries,
    "case_law.eu_completion.rows_failed": report.failed,
    "case_law.eu_completion.failed": Number(report.status === "failed"),
    "case_law.eu_completion.publisher_refused": Number(
      report.status === "publisher-refused",
    ),
    "case_law.eu_completion.requests": report.requests,
    "case_law.eu_completion.request_budget": EU_COMPLETION_LIMITS.maxRequests,
    "case_law.eu_completion.cursor_moved": report.cursorMoved,
    "case_law.eu_completion.no_progress": report.noProgress,
    "case_law.eu_completion.duration_ms": report.durationMs,
  };
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: "Stella/CaseLaw",
          Dimensions: [["AdapterKey", "Mode"]],
          Metrics: Object.keys(values).map((Name) => ({
            Name,
            Unit: Name.endsWith("duration_ms") ? "Milliseconds" : "Count",
          })),
        },
      ],
    },
    event: "case_law.eu_completion.tick",
    AdapterKey: ADAPTER_KEYS.EU_ECJ,
    Mode: mode,
    status: report.status,
    ...values,
  };
};

type CompletionQueueMetricOptions = {
  mode: "dry-run" | "apply";
  timestamp: number;
  probe: {
    hasQueuedWork: boolean;
    mirrorRepairRequired: boolean;
    oldestRetryAgeMs: number | null;
    lastCompletedAt: Date | null;
  };
};
export const euCompletionQueueMetricRecord = ({
  mode,
  timestamp,
  probe,
}: CompletionQueueMetricOptions) => {
  const values = {
    "case_law.eu_completion.queued_work_present": Number(probe.hasQueuedWork),
    "case_law.eu_completion.mirror_repair_required_present": Number(
      probe.mirrorRepairRequired,
    ),
    ...(probe.oldestRetryAgeMs === null
      ? {}
      : {
          "case_law.eu_completion.oldest_retry_age_ms": probe.oldestRetryAgeMs,
        }),
    ...(probe.lastCompletedAt === null
      ? {}
      : {
          "case_law.eu_completion.last_success_age_ms": Math.max(
            0,
            timestamp - probe.lastCompletedAt.getTime(),
          ),
        }),
  };
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: "Stella/CaseLaw",
          Dimensions: [["AdapterKey", "Mode"]],
          Metrics: Object.keys(values).map((Name) => ({
            Name,
            Unit: Name.endsWith("_ms") ? "Milliseconds" : "Count",
          })),
        },
      ],
    },
    event: "case_law.eu_completion.queue",
    AdapterKey: ADAPTER_KEYS.EU_ECJ,
    Mode: mode,
    ...values,
  };
};

const emptyReport = (
  status: EuCompletionReport["status"],
): EuCompletionReport => ({
  status,
  attempted: 0,
  applied: 0,
  unchanged: 0,
  reviewRequired: 0,
  retries: 0,
  failed: 0,
  requests: 0,
  cursorMoved: 0,
  noProgress: 0,
  durationMs: 0,
});

const enabledNow = (
  mode?: ReturnType<
    typeof readEuCompletionTickEnvironment
  >["CASE_LAW_EU_COMPLETION_MODE"],
) => {
  const environment = readEuCompletionTickEnvironment();
  return (
    environment.CASE_LAW_EU_COMPLETION_ENABLED &&
    !environment.CASE_LAW_EU_COMPLETION_KILL_SWITCH &&
    (mode === undefined || environment.CASE_LAW_EU_COMPLETION_MODE === mode)
  );
};

const loadRuntime = async () => {
  const [
    { withLongRunningConnection },
    { createScriptBackfillHealthReader },
    { createHeavyWorkSlot },
    { createEuCompletionStore },
    { runEuCompletionTick },
    { createEuCompletionRunner },
    { acquireCaseLawSourceIngestionLease },
  ] = await Promise.all([
    import("@/api/db/long-running-connection"),
    import("@/api/db/backfill-runtime"),
    import("@stll/db-load-gate/slot"),
    import("@/api/handlers/case-law/ingestion/eu-completion-store"),
    import("@/api/handlers/case-law/ingestion/eu-completion"),
    import("@/api/handlers/case-law/ingestion/eu-completion-runner"),
    import("@/api/lib/legal-search/case-law-source-ingestion-lease"),
  ]);
  // Named, so the import shows which schema table it takes.
  const { caseLawSources } = await import("@/api/db/schema");
  return {
    withLongRunningConnection,
    createScriptBackfillHealthReader,
    createHeavyWorkSlot,
    createEuCompletionStore,
    runEuCompletionTick,
    createEuCompletionRunner,
    acquireCaseLawSourceIngestionLease,
    caseLawSources,
  };
};

type CompletionRuntime = Awaited<ReturnType<typeof loadRuntime>>;
type CompletionFixtureOptions = {
  healthConfig?: Pick<HealthConfig, "busyWindows">;
  readHealthVerdict?: () => Promise<Verdict>;
  afterDocument?: () => Promise<void>;
  beforeWriteFence?: () => Promise<void>;
};
type CompletionFenceOptions = {
  runtime: CompletionRuntime;
  handles: CaseLawScriptHandles;
  cleanup: CaseLawScriptHandles;
  connection: ReservedSQL;
  sourceId: SafeId<"caseLawSource">;
  signal: AbortSignal;
};

const createCompletionFence = async ({
  runtime,
  handles,
  cleanup,
  connection,
  sourceId,
  signal,
}: CompletionFenceOptions) => {
  const mode = readEuCompletionTickEnvironment().CASE_LAW_EU_COMPLETION_MODE;
  const backend = (
    await connection.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid")
  ).at(0)?.pid;
  if (backend === undefined) {
    panic("Completion heavy-work session returned no backend identity");
  }
  const slot = runtime.createHeavyWorkSlot({
    kind: "backfill_batch",
    session: {
      query: async (statement, parameters) =>
        await connection.unsafe<{ acquired: boolean }[]>(statement, [
          ...parameters,
        ]),
    },
  });
  let slotHeld = false;
  let lease: CaseLawSourceIngestionLease | null = null;
  return {
    getLease: () => lease,
    fence: async () => {
      signal.throwIfAborted();
      if (!enabledNow(mode)) {
        throw new EuCompletionStop({
          message: "Completion switches changed",
          reason: "off",
        });
      }
      if (!slotHeld) {
        const acquired = await slot.tryAcquire();
        if (acquired.isErr()) {
          throw acquired.error;
        }
        if (!acquired.value) {
          throw new EuCompletionStop({
            message: "Completion heavy-work slot is held",
            reason: "held",
          });
        }
        slotHeld = true;
      }
      await assertReplaySlot({
        expectedBackend: backend,
        signal,
        queryBackend: async () =>
          (
            await connection.unsafe<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).at(0)?.pid,
      });
      await lease?.beforeDatabaseMark();
      signal.throwIfAborted();
    },
    acquireDocument: async () => {
      signal.throwIfAborted();
      lease ??= await runtime.acquireCaseLawSourceIngestionLease({
        scopedDb: handles.ingestionDb,
        sourceId,
        releaseDb: cleanup.ingestionDb,
      });
      if (lease === null) {
        throw new EuCompletionStop({
          message: "Completion source lease is held",
          reason: "held",
        });
      }
    },
    releaseDocument: async () => {
      const acquired = lease;
      lease = null;
      await acquired?.release();
    },
    close: async () => {
      try {
        await lease?.release();
      } finally {
        await slot.close();
      }
    },
  };
};

type RunCompletionSessionOptions = CompletionFenceOptions & {
  fixture: CompletionFixtureOptions;
};
const runCompletionSession = async (
  options: RunCompletionSessionOptions,
): Promise<EuCompletionReport> => {
  const { runtime, handles, cleanup, sourceId, signal, fixture } = options;
  const environment = readEuCompletionTickEnvironment();
  const store = runtime.createEuCompletionStore({
    db: handles.rootDb,
    cleanupDb: cleanup.rootDb,
    now,
  });
  const cleanupStore = runtime.createEuCompletionStore({
    db: cleanup.rootDb,
    now,
  });
  const resources = await createCompletionFence(options);
  const health = runtime.createScriptBackfillHealthReader({
    db: handles.rootDb,
    tableName: "case_law_decisions",
    clock: now,
    config: { ...REPLAY_HEALTH_CONFIG, ...fixture.healthConfig },
  });
  const preflight = createReplayPreflightGate({
    readVerdict: async () =>
      fixture.readHealthVerdict
        ? await fixture.readHealthVerdict()
        : await readReplayGate(health),
    loadState: store.loadPreflightGateState,
    saveState: store.savePreflightGateState,
    clock: now,
  });
  let requests = 0;
  const runner = runtime.createEuCompletionRunner({
    rootDb: handles.rootDb,
    ingestionDb: handles.ingestionDb,
    store,
    sourceLease: resources.getLease,
    ...(fixture.beforeWriteFence
      ? { beforeWriteFence: fixture.beforeWriteFence }
      : {}),
    signal,
    check: async () =>
      await Result.tryPromise({
        try: resources.fence,
        catch: (error) => error,
      }),
    raiseFailure: (error) => {
      throw error;
    },
    isEnabled: () => enabledNow(environment.CASE_LAW_EU_COMPLETION_MODE),
    onRequest: () => {
      requests++;
    },
  });
  const startedAt = now();
  try {
    const attempted = await Result.tryPromise(
      async () =>
        await runtime.runEuCompletionTick({
          sourceId,
          mode: environment.CASE_LAW_EU_COMPLETION_MODE,
          parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
          maxRows: environment.CASE_LAW_EU_COMPLETION_MAX_ROWS,
          signal,
          now,
          dependencies: {
            store,
            isEnabled: () =>
              enabledNow(environment.CASE_LAW_EU_COMPLETION_MODE),
            readGate: preflight.readVerdict,
            fence: resources.fence,
            requestCount: () => requests,
            runRow: async (receipt, rowOptions) => {
              const acquired = await Result.tryPromise({
                try: resources.acquireDocument,
                catch: (error) => error,
              });
              if (acquired.isErr()) {
                return acquired;
              }
              try {
                return await runner.runRow(receipt, rowOptions);
              } finally {
                await resources.releaseDocument();
                await fixture.afterDocument?.();
              }
            },
          },
        }),
    );
    const report = attempted.isOk()
      ? attempted.value
      : {
          ...emptyReport("failed"),
          requests,
          durationMs: Math.max(0, now() - startedAt),
        };
    if (attempted.isErr()) {
      log({
        event: "case_law.eu_completion.tick_failure",
        ...classifyReplayFailure(attempted.error),
      });
    }
    // A throwing core boundary still needs a durable heartbeat.
    if (attempted.isErr()) {
      await cleanupStore.recordTick({
        sourceId,
        mode: environment.CASE_LAW_EU_COMPLETION_MODE,
        healthyCompleted: 0,
        intentionallyHeld:
          report.status === "held" ||
          report.status === "off" ||
          report.status === "approval-required",
        counts: {
          attempted: report.attempted,
          applied: report.applied,
          unchanged: report.unchanged,
          reviewRequired: report.reviewRequired,
          failed: report.failed,
        },
      });
    }
    // Admission holds do not trigger queue probes or bookkeeping sweeps.
    if (report.status === "completed") {
      const probed = await Result.tryPromise(
        async () =>
          await cleanupStore.probe({
            sourceId,
            mode: environment.CASE_LAW_EU_COMPLETION_MODE,
            parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
          }),
      );
      if (probed.isOk()) {
        log(
          euCompletionQueueMetricRecord({
            mode: environment.CASE_LAW_EU_COMPLETION_MODE,
            timestamp: now(),
            probe: probed.value,
          }),
        );
      } else {
        log({
          event: "case_law.eu_completion.queue_probe_deferred",
          ...classifyReplayFailure(probed.error),
        });
      }
    }
    if (report.status === "completed") {
      const compacted = await Result.tryPromise(
        async () =>
          await cleanupStore.compact({ limit: EU_COMPLETION_LIMITS.maxRows }),
      );
      if (compacted.isErr()) {
        log({
          event: "case_law.eu_completion.compaction_deferred",
          ...classifyReplayFailure(compacted.error),
        });
      }
    }
    return report;
  } finally {
    try {
      await health.settle();
    } finally {
      await resources.close();
    }
  }
};

const runEnabledWithOptions = async (
  signal: AbortSignal,
  fixture: CompletionFixtureOptions,
): Promise<EuCompletionReport> => {
  signal.throwIfAborted();
  if (!enabledNow()) {
    return emptyReport("off");
  }
  const runtime = await loadRuntime();
  const cleanup = await createCaseLawMaintenanceCleanupHandles({
    timeoutMs: CLEANUP_TIMEOUT_MS,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
  });
  const report = await enterCaseLawMaintenanceLane({
    mode: "bounded",
    signal,
    statementTimeout: QUERY_TIMEOUT_MS,
    lockTimeout: QUERY_TIMEOUT_MS,
    work: async (handles) => {
      const source = (
        await handles.rootDb.transaction(
          async (tx) =>
            await tx
              .select({ id: runtime.caseLawSources.id })
              .from(runtime.caseLawSources)
              .where(eq(runtime.caseLawSources.adapterKey, ADAPTER_KEYS.EU_ECJ))
              .limit(1),
        )
      ).at(0);
      if (source === undefined) {
        panic("Completion requires its EU source");
      }
      return await runtime.withLongRunningConnection(
        {
          statementTimeout: QUERY_TIMEOUT_MS,
          lockTimeout: QUERY_TIMEOUT_MS,
          signal,
        },
        async ({ connection }) =>
          await runCompletionSession({
            runtime,
            handles,
            cleanup,
            connection,
            sourceId: source.id,
            signal,
            fixture,
          }),
      );
    },
  });
  return report ?? emptyReport("held");
};

const runEnabledEuCompletionTick = async (signal: AbortSignal) =>
  await runEnabledWithOptions(signal, {});

/** Test configuration is inaccessible before a local harness passes this guard. */
export const getEuCompletionFixtureRunner = () => {
  if (!isLocalTestRun()) {
    return panic("Completion fixtures require a local test run");
  }
  return async (signal: AbortSignal, fixture: CompletionFixtureOptions) => {
    if (!isLocalTestRun()) {
      return panic("Completion fixtures require a local test run");
    }
    return await runEnabledWithOptions(signal, fixture);
  };
};

type CompletionScriptOptions = {
  args?: readonly string[];
  environment?: ReturnType<typeof readEuCompletionTickEnvironment>;
  runEnabled?: typeof runEnabledEuCompletionTick;
  log?: (record: unknown) => void;
};

export const runEuCompletionTickScript = async ({
  args = [],
  environment,
  runEnabled = runEnabledEuCompletionTick,
  log: write = log,
}: CompletionScriptOptions = {}) => {
  let mode: ReturnType<
    typeof readEuCompletionTickEnvironment
  >["CASE_LAW_EU_COMPLETION_MODE"] = "dry-run";
  let enabled = false;
  const attempted = await Result.tryPromise(async () => {
    if (args.length > 0) {
      panic("Completion ticks accept operational environment switches only");
    }
    const controls = environment ?? readEuCompletionTickEnvironment();
    mode = controls.CASE_LAW_EU_COMPLETION_MODE;
    enabled =
      controls.CASE_LAW_EU_COMPLETION_ENABLED &&
      !controls.CASE_LAW_EU_COMPLETION_KILL_SWITCH;
    const report = enabled
      ? await runEnabled(
          AbortSignal.timeout(EU_COMPLETION_LIMITS.hardDurationMs),
        )
      : emptyReport("off");
    write(
      euCompletionMetricRecord({ report, mode, enabled, timestamp: now() }),
    );
    return report.status === "failed" ? 1 : 0;
  });
  if (attempted.isOk()) {
    return attempted.value;
  }
  write(
    euCompletionMetricRecord({
      report: emptyReport("failed"),
      mode,
      enabled,
      timestamp: now(),
    }),
  );
  write({
    event: "case_law.eu_completion.tick_failure",
    ...classifyReplayFailure(attempted.error),
  });
  return 1;
};

if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    process.exit(
      await runEuCompletionTickScript({ args: process.argv.slice(2) }),
    );
  });
}
