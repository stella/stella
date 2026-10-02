import { panic, Result } from "better-result";
import { SQL } from "bun";

import type { Verdict } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import { createScriptBackfillHealthReader } from "@/api/db/backfill-runtime";
import { readReplayTickEnvironment } from "@/api/env-base-schema";
import {
  runBackgroundReplayTick,
  type BackgroundReplaySource,
} from "@/api/handlers/case-law/ingestion/background-replay";
import { createBackgroundReplayRunner } from "@/api/handlers/case-law/ingestion/background-replay-runner";
import { createBackgroundReplayStore } from "@/api/handlers/case-law/ingestion/background-replay-store";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  replayKillRequested,
  type ReplayEnrolment,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { tryEnterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import {
  acquireCaseLawSourceIngestionLease,
  type CaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const now = () => Temporal.Now.instant().epochMilliseconds;
const log = (record: unknown) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
const metric = (
  source: BackgroundReplaySource,
  event: string,
  values: Record<string, number>,
) => {
  log({
    _aws: {
      Timestamp: now(),
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
};

/** A bounded scheduled invocation: no waiting for leases, slots or health holds. */
const main = async () => {
  if (process.argv.length > 2) {
    panic(
      "replay-tick takes no arguments; enrolment and limits are reviewed configuration",
    );
  }
  const policies: readonly ReplayEnrolment[] = Object.values(REPLAY_ENROLMENT);
  const environment = readReplayTickEnvironment();
  if (
    !environment.CASE_LAW_REPLAY_ENABLED ||
    environment.CASE_LAW_REPLAY_KILL_SWITCH ||
    policies.every((policy) => policy.mode === "off")
  ) {
    log({ event: "case_law.replay.tick", status: "disabled" });
    return;
  }
  const lane = await tryEnterCaseLawMaintenanceLane();
  if (lane === null) {
    log({ event: "case_law.replay.tick", status: "maintenance-held" });
    return;
  }
  try {
    const { envBase } = await import("@/api/env-base");
    const lockClient = new SQL({ url: envBase.DATABASE_URL, max: 1 });
    try {
      const connection = await lockClient.reserve();
      try {
        const lockBackend = (
          await connection.unsafe<{ pid: number }[]>(
            "SELECT pg_backend_pid() AS pid",
          )
        ).at(0)?.pid;
        if (lockBackend === undefined) {
          panic("Heavy-work session returned no backend identity");
        }
        const slot = createHeavyWorkSlot({
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
        const health = createScriptBackfillHealthReader({
          db: lane.rootDb,
          tableName: "case_law_decisions",
          clock: now,
        });
        let lastVerdict: Verdict = { kind: "unknown", signals: [] };
        let lease: CaseLawSourceIngestionLease | null = null;
        const store = createBackgroundReplayStore({
          db: lane.rootDb,
          now,
          sourceEnabled: (key) => !replayKillRequested(key),
          onBudgetExhausted: (source) =>
            metric(source, "case_law.replay.tick", {
              "case_law.replay.tick.budget_exhausted": 1,
            }),
          onLag: (source) =>
            metric(source, "case_law.replay.lag", {
              "case_law.replay.lag.rows_behind": source.rowsBehind,
              "case_law.replay.lag.oldest_age_ms": source.oldestAgeMs,
              "case_law.replay.lag.blocked_count": source.blockedCount,
            }),
        });
        const runner = createBackgroundReplayRunner({
          rootDb: lane.rootDb,
          ingestionDb: lane.ingestionDb,
          getLease: () => lease,
          assertSlot: async () => {
            const current = (
              await connection.unsafe<{ pid: number }[]>(
                "SELECT pg_backend_pid() AS pid",
              )
            ).at(0)?.pid;
            if (current !== lockBackend) {
              panic("Heavy-work session was replaced; replay must stop");
            }
          },
          store,
          log,
        });
        try {
          await refreshS3();
          await refreshCorpusS3();
          const tickReport = await runBackgroundReplayTick({
            ...BACKGROUND_REPLAY_LIMITS,
            dependencies: {
              ...store,
              killRequested: async (source) =>
                await Promise.resolve(replayKillRequested(source.adapterKey)),
              reserveBatch: async (source, day) =>
                await store.reserveBatch(source, day, lastVerdict),
              acquireLease: async (source) => {
                lease = await acquireCaseLawSourceIngestionLease({
                  scopedDb: lane.ingestionDb,
                  sourceId: source.id,
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
              acquireHeavySlot: async () => {
                const acquired = await slot.tryAcquire();
                if (acquired.isErr()) {
                  throw acquired.error;
                }
                return acquired.value ? slot.release : null;
              },
              gate: async () => {
                const result = await Result.tryPromise(health.readVerdict);
                await health.settle();
                lastVerdict = result.isOk()
                  ? result.value
                  : { kind: "unknown", signals: [] };
                return lastVerdict;
              },
              ...runner,
              metric: (report) => {
                if (report.source) {
                  metric(report.source, "case_law.replay.tick", {
                    "case_law.replay.tick.applied": report.applied,
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
              },
              now,
              sleep: async (milliseconds) => {
                await Bun.sleep(milliseconds);
              },
            },
          });
          if (
            tickReport.status === "error-ceiling" ||
            tickReport.status === "retryable"
          ) {
            process.exitCode = 1;
          }
        } finally {
          try {
            await health.settle();
          } finally {
            await slot.close();
          }
        }
      } finally {
        connection.release();
      }
    } finally {
      await lockClient.close();
    }
  } finally {
    await lane.release();
  }
};

const outcome = await Result.tryPromise(main);
if (outcome.isErr()) {
  log({
    event: "case_law.replay.tick",
    status: "failed",
    error: outcome.error.message,
  });
  process.exitCode = 1;
}
// The maintenance handles own pools; ending the process closes their sessions.
process.exit(process.exitCode ?? 0);
