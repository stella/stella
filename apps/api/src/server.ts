import { panic } from "better-result";

import { HTTP_REQUEST_BODY_MAX_BYTES } from "@stll/api-contract/limits";
import { redisConnectionConfig } from "@stll/redis-config";

import { initApiBackgroundWorkers } from "@/api/api-background-workers";
import { apiPipeline } from "@/api/api-pipeline";
import { apiRoutes } from "@/api/api-routes";
import { readRootPoolReport } from "@/api/db/root";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { reapOwnerlessChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { relinquishChatTurnRuns } from "@/api/handlers/chat/chat-turn-run";
import { initBuiltinReportTemplates } from "@/api/handlers/reports/builtin-templates";
import { clearLookupPreviewCache } from "@/api/handlers/templates/lookup-preview-cache";
import { createHttpApp } from "@/api/http/app";
import { detached } from "@/api/lib/analytics/capture";
import { realtimeAuthorizers } from "@/api/lib/auth";
import { startManagedProviderChecks } from "@/api/lib/chat/managed-provider-checks";
import { clientAddressConfigurationWarning } from "@/api/lib/client-ip";
import { assertConfiguredBetterAuthOAuthPolicy } from "@/api/lib/db/assert-better-auth-oauth-policy";
import { assertMigrationsApplied } from "@/api/lib/db/assert-migrations-applied";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/utils";
import {
  openFreshLoginClient,
  startDatabaseLoginProbe,
} from "@/api/lib/health/database-login-probe";
import { markScheduledJobsReady } from "@/api/lib/health/readiness";
import { readWorkPoolMetrics } from "@/api/lib/load/work-admission";
import { createMemoryPressureHandler } from "@/api/lib/memory-pressure";
import { startEventLoopDelayMonitor } from "@/api/lib/observability/event-loop-delay";
import { logger } from "@/api/lib/observability/logger";
import {
  emitEventLoopDelayMetric,
  emitProcessMemoryLog,
} from "@/api/lib/observability/request-metrics";
import {
  closeActionAdmissionRedis,
  startActionAdmissionRedis,
} from "@/api/lib/rate-limit/action-admission";
import {
  closeMcpReadFenceRedis,
  startMcpReadFenceRedis,
} from "@/api/lib/rate-limit/mcp-read-fence";
import { closeRateLimitContexts } from "@/api/lib/rate-limit/rate-limit";
import {
  refreshCorpusS3,
  refreshS3,
  refreshStaleCorpusS3,
  refreshStaleS3,
} from "@/api/lib/s3";
import { ensureDefaultSchedulerJobs } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { startSchedulerLoop } from "@/api/lib/scheduler/runner";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { createReapOwnerlessChatTurnsTask } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import { startSse, stopSse } from "@/api/lib/sse";
import { clearByokAdapterCache } from "@/api/lib/tanstack-ai-models";
import { flushActionCostRecords } from "@/api/lib/usage/action-costs/recorder";
import { isLocalDevOpen } from "@/api/runtime-mode";
import { startConfiguredScheduler } from "@/api/server-scheduled-jobs";
import {
  API_SHUTDOWN_OUTCOME,
  shutdownApiServices,
} from "@/api/server-shutdown";

const DEFAULT_API_PORT = 3001;
const S3_REFRESH_CHECK_INTERVAL_MS = 60_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

const getApiPort = () => {
  const rawPort = env.STELLA_API_PORT ?? env.PORT;
  if (!rawPort) {
    return DEFAULT_API_PORT;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return DEFAULT_API_PORT;
  }

  return parsedPort;
};

const startMemoryPressureHandler = () => {
  process.on(
    "memoryPressure",
    createMemoryPressureHandler({
      caches: [
        { clear: clearLookupPreviewCache },
        { clear: clearByokAdapterCache },
      ],
      onEviction: ({ evictedEntries, level }) => {
        logger.warn("runtime.memory_pressure", {
          "cache.evicted_entries": evictedEntries,
          "memory.pressure_level": level,
        });
      },
    }),
  );
};

const readProcessMemoryReport = () => {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    arrayBuffersBytes: usage.arrayBuffers,
    workPools: readWorkPoolMetrics(),
  };
};

// One stall on this loop delays every request the task is serving, so it is
// reported as soon as the loop is free, and its window's delay as a metric.
const startEventLoopDelayReporting = () => {
  let reporting: Promise<void> | undefined;
  startEventLoopDelayMonitor({
    onReportInterval: () => emitProcessMemoryLog(readProcessMemoryReport()),
    onReport: (delay) => {
      if (reporting !== undefined) {
        return;
      }
      reporting = readRootPoolReport()
        .then((rootPool) =>
          emitEventLoopDelayMetric({
            ...delay,
            rootPool,
          }),
        )
        .finally(() => {
          reporting = undefined;
        });
    },
    onStall: (stallMs) => {
      logger.warn("runtime.event_loop_stalled", {
        "event_loop.stall_ms": stallMs,
      });
    },
  });
};

/** The API: one route table behind one pipeline, served by `Bun.serve`. */
export const apiApp = createHttpApp({
  routes: apiRoutes,
  middleware: apiPipeline,
});

const startS3RefreshLoop = () => {
  const timer = setInterval(() => {
    // `refreshStale*` own both the staleness test and the deduplication, so a
    // resolution still in flight when the next tick arrives is joined rather
    // than started again.
    refreshStaleS3().catch((error: unknown) => {
      logger.error("s3.refresh_failed", {
        "error.type": errorTag(error),
      });
    });

    refreshStaleCorpusS3().catch((error: unknown) => {
      logger.error("s3.corpus_refresh_failed", {
        "error.type": errorTag(error),
      });
    });
  }, S3_REFRESH_CHECK_INTERVAL_MS);

  timer.unref();
};

// Booting (migration check, S3 warmup, BullMQ workers, bound port) runs
// only when this module is the process entry point: `bun src/server.ts` in
// dev and the `bun build --compile` binary in prod. Importing the module
// instead must yield the fully constructed `apiApp` without any of these side
// effects (no DB, no Redis, no listen).
const startServer = async (): Promise<void> => {
  const clientAddressWarning = clientAddressConfigurationWarning({
    edgeHeader: env.STELLA_CLIENT_ADDRESS_HEADER,
    originVerifySecret: env.STELLA_ORIGIN_VERIFY_SECRET,
    originVerifySecretPrevious: env.STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS,
  });
  if (clientAddressWarning !== null) {
    logger.warn(clientAddressWarning, {
      "clientAddress.configurationWarning": 1,
    });
  }
  if (envBase.REDIS_URL !== undefined) {
    const { mode } = redisConnectionConfig({
      url: envBase.REDIS_URL,
      settings: envBase,
      rejectUnauthorized: envBase.REDIS_TLS_REJECT_UNAUTHORIZED,
    }).unwrap("Redis connection configuration must be valid.");
    logger.info("redis.connection.mode", { mode });
    if (isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION")) {
      detached(startActionAdmissionRedis(), "admission-store.start");
    }
    if (isDeploymentFeatureEnabled("FEATURE_MCP_READ_FENCE")) {
      detached(startMcpReadFenceRedis(), "read-fence-store.start");
    }
  }

  startMemoryPressureHandler();

  // Start the SSE keep-alive heartbeat and cross-instance Redis subscriber
  // first, before any awaited setup below, so its connection timing
  // matches the previous import-time behavior and completes well before
  // `Bun.serve` starts accepting requests.
  startSse(realtimeAuthorizers);

  // Schema-drift fail-fast. If the runtime expects migrations
  // the database has not received, exit before serving any
  // request against a stale schema.
  await assertMigrationsApplied();

  // The OAuth resource backfill is deployment-owned rather than a committed
  // migration. Refuse readiness when it was skipped or only partially ran;
  // otherwise agent authorization would fail on first use after deployment.
  await assertConfiguredBetterAuthOAuthPolicy();

  await Promise.all([refreshS3(), refreshCorpusS3()]);
  startS3RefreshLoop();

  // Config fail-fast: an invalid bundled or runtime report spec must stop the
  // boot, not fail the first export that picks it. After the S3 refresh so a
  // REPORT_SPECS_S3_PREFIX read uses resolved credentials.
  await initBuiltinReportTemplates();

  const closeManagedProviderChecks = await startManagedProviderChecks();
  const backgroundWorkers = await initApiBackgroundWorkers(
    env.SCHEDULED_JOBS_MODE,
  );

  // Every process outside local development starts it. Same URL as the pools
  // in `db/root.ts`.
  const closeDatabaseLoginProbe = isLocalDevOpen()
    ? undefined
    : startDatabaseLoginProbe({
        openClient: () => openFreshLoginClient(envBase.DATABASE_URL),
      });

  const server = Bun.serve({
    port: getApiPort(),
    ...apiApp.serveOptions,
    maxRequestBodySize: HTTP_REQUEST_BODY_MAX_BYTES,
  });

  // From here the loop serves requests; boot work before this point delays
  // none, so it stays out of the stall signal.
  startEventLoopDelayReporting();

  // Filled in after the handlers below are attached, so a signal arriving
  // during scheduler registration still finds a shutdown path. A holder rather
  // than a binding because the shutdown closure is created before the loop
  // exists and has to observe it once it does.
  const scheduler: {
    loop: ReturnType<typeof startSchedulerLoop> | undefined;
  } = { loop: undefined };

  // Graceful shutdown: stop accepting HTTP requests, close long-lived SSE
  // streams, then drain the BullMQ workers on SIGTERM/SIGINT (deploy,
  // container stop, or a local `bun --watch` restart) so an in-flight job is
  // not abandoned mid-write.
  // An abandoned job strands its workflow lock and leaves cells stuck
  // `pending` until the next boot reconciles them; draining avoids creating
  // that orphan in the common case. Worker draining is bounded so a slow job
  // can't hang shutdown; anything still in flight past the timeout is
  // reclaimed by the next boot's reconciler.
  let shuttingDown = false;
  const shutdownWorkers = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("api.shutdown_started", { signal });
    const outcome = await shutdownApiServices({
      closeBackgroundWorkers: async () => {
        await backgroundWorkers.close();
      },
      closeManagedProviderChecks,
      closeDatabaseLoginProbe,
      // Undefined when the signal beat scheduler registration; there is
      // nothing claimed to drain.
      drainScheduler: scheduler.loop?.drained,
      onHttpStopError: (error) => {
        logger.error("api.stop_failed", {
          "error.type": errorTag(error),
        });
      },
      relinquishChatTurnRuns,
      stopHttp: async () => {
        await server.stop();
      },
      // Stop claiming new jobs before draining, so a tick in flight finishes
      // and releases its lease rather than leaving it to expire.
      stopScheduler: () => scheduler.loop?.stop(),
      stopSse,
      timeout: Bun.sleep(WORKER_SHUTDOWN_TIMEOUT_MS),
    });
    await Promise.race([
      flushActionCostRecords(),
      Bun.sleep(WORKER_SHUTDOWN_TIMEOUT_MS),
    ]);
    closeActionAdmissionRedis();
    closeMcpReadFenceRedis();
    await closeRateLimitContexts();
    switch (outcome) {
      case API_SHUTDOWN_OUTCOME.drained:
        logger.info("api.shutdown_complete", { signal });
        return process.exit(0);
      case API_SHUTDOWN_OUTCOME.failed:
        logger.error("api.shutdown_failed", { signal });
        return process.exit(1);
      case API_SHUTDOWN_OUTCOME.timedOut:
        logger.warn("api.shutdown_timed_out", { signal });
        return process.exit(1);
      default: {
        outcome satisfies never;
        return panic(`Unhandled API shutdown outcome: ${String(outcome)}`);
      }
    }
  };
  process.once("SIGTERM", () => {
    detached(shutdownWorkers("SIGTERM"), "server.shutdown");
  });
  process.once("SIGINT", () => {
    detached(shutdownWorkers("SIGINT"), "server.shutdown");
  });

  // Scheduled jobs run here rather than in a process of their own. A separate
  // deployment unit has to be remembered, and when it is forgotten nothing
  // says so: the jobs simply never run, which is indistinguishable from having
  // no work to do. Hosting the loop in a service that must exist for the
  // product to work at all removes that failure mode instead of monitoring it.
  // Each job is leased individually (`locked_by`/`locked_until`), so running
  // this in every replica is safe.
  //
  // Last on purpose. After `listen`, so liveness can distinguish slow setup
  // from a dead process; readiness remains false until registration completes.
  // After the signal handlers, because registration is awaited,
  // and a deploy landing inside that window would otherwise find no shutdown
  // path for the SSE loop, the S3 refresh loop and the listening socket.
  scheduler.loop = await startConfiguredScheduler({
    mode: env.SCHEDULED_JOBS_MODE,
    ensureDefaultJobs: ensureDefaultSchedulerJobs,
    startLoop: () =>
      startSchedulerLoop({
        registry: createSchedulerTaskRegistry(
          createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx),
          {
            refreshCaseLawCoverage: createCaseLawCoverageRefreshTask({
              compute: computeCaseLawCoverageAnswer,
            }),
          },
        ),
      }),
    logger,
  });
  markScheduledJobsReady();
};

if (import.meta.main) {
  await startServer();
}
