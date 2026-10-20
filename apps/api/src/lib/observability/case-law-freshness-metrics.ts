import { panic, Result } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import type { Transaction } from "@/api/db/root";
import {
  caseLawSources,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { readUnderCaseLawFreshnessSessionLock } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexProjectionConvergenceTx } from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  buildCaseLawOldestUnpublishedAgeMetric,
  buildCaseLawProjectionBacklogMetric,
  buildCaseLawProjectionConvergenceMetric,
  buildCaseLawSourceSyncAgeMetric,
  writeMetricLine,
} from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";
import { isLocalTestRun } from "@/api/runtime-mode";

const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const STATEMENT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 1000;
const SCHEDULED_SOURCE_KEYS = Object.values(ADAPTER_KEYS);
const FRESHNESS_METRICS_SINK = failureSink({
  event: "case_law.freshness_metrics",
  expected: [],
});

type CaseLawFreshnessReport = {
  backlogItems: number;
  oldestUnpublishedAgeSeconds: number;
  sourceAges: readonly { source: string; ageSeconds: number }[];
  convergence: string | null;
};

const requiredNumber = (row: unknown, key: string): number => {
  if (!isRecord(row) || typeof row[key] !== "number") {
    return panic(`Malformed case-law freshness query result: ${key}`);
  }
  return row[key];
};

export const readCaseLawFreshnessReportTx = async (
  tx: Transaction,
): Promise<CaseLawFreshnessReport> => {
  const pendingState = sql`${corpusIndexProjectionStates.desiredEpoch} > coalesce(${corpusIndexProjectionStates.appliedEpoch}, -1)`;
  const [stateRows, intentRows, sourceRows, serving] = await Promise.all([
    tx.execute(sql`SELECT count(*)::int AS count,
      coalesce(extract(epoch FROM clock_timestamp() - min(${corpusIndexProjectionStates.createdAt})), 0)::float8 AS age
      FROM ${corpusIndexProjectionStates}
      WHERE ${corpusIndexProjectionStates.family} = 'case_law' AND ${pendingState}`),
    tx.execute(sql`SELECT count(*)::int AS count,
      coalesce(extract(epoch FROM clock_timestamp() - min(${corpusIndexProjectionIntents.createdAt})), 0)::float8 AS age
      FROM ${corpusIndexProjectionIntents}
      WHERE ${corpusIndexProjectionIntents.family} = 'case_law'
        AND ${ne(corpusIndexProjectionIntents.status, "settled")}
        AND ${ne(corpusIndexProjectionIntents.status, "cancelled")}`),
    tx
      .select({
        source: caseLawSources.adapterKey,
        ageSeconds: sql<number>`extract(epoch FROM clock_timestamp() - coalesce(${caseLawSources.lastSyncAt}, 'epoch'::timestamptz))::float8`,
      })
      .from(caseLawSources)
      .where(
        and(
          eq(caseLawSources.enabled, true),
          inArray(caseLawSources.adapterKey, SCHEDULED_SOURCE_KEYS),
        ),
      ),
    readServingCorpusIndexGenerationTx(tx, "case_law"),
  ]);
  const state = executedRows(stateRows).at(0);
  const intent = executedRows(intentRows).at(0);
  const stateCount = requiredNumber(state, "count");
  const intentCount = requiredNumber(intent, "count");
  const oldestAge = Math.max(
    requiredNumber(state, "age"),
    requiredNumber(intent, "age"),
  );
  const convergence = Result.isOk(serving)
    ? await readCorpusIndexProjectionConvergenceTx(tx, serving.value)
    : null;
  return {
    backlogItems: stateCount + intentCount,
    oldestUnpublishedAgeSeconds: oldestAge,
    sourceAges: sourceRows,
    convergence,
  };
};

export const emitCaseLawFreshnessReport = (
  report: CaseLawFreshnessReport,
): void => {
  writeMetricLine(buildCaseLawProjectionBacklogMetric(report.backlogItems));
  writeMetricLine(
    buildCaseLawOldestUnpublishedAgeMetric(report.oldestUnpublishedAgeSeconds),
  );
  for (const source of report.sourceAges) {
    writeMetricLine(
      buildCaseLawSourceSyncAgeMetric(source.source, source.ageSeconds),
    );
  }
  if (report.convergence !== null) {
    writeMetricLine(
      buildCaseLawProjectionConvergenceMetric(report.convergence),
    );
  }
};

type TickSession = {
  tryLock: () => Promise<boolean>;
  read: () => Promise<CaseLawFreshnessReport>;
};

export const runCaseLawFreshnessMetricTick = async (
  openSession: (work: (session: TickSession) => Promise<void>) => Promise<void>,
): Promise<void> => {
  await openSession(async (session) => {
    if (!(await session.tryLock())) {
      return;
    }
    emitCaseLawFreshnessReport(await session.read());
  });
};

const runProductionTick = async (): Promise<void> => {
  const signal = AbortSignal.timeout(STATEMENT_TIMEOUT_MS);
  await runCaseLawFreshnessMetricTick(async (work) => {
    await withLongRunningConnection(
      {
        signal,
        statementTimeout: STATEMENT_TIMEOUT_MS,
        lockTimeout: LOCK_TIMEOUT_MS,
      },
      async ({ db, connection }) => {
        let result: CaseLawFreshnessReport | null = null;
        await work({
          tryLock: async () => {
            const locked = await readUnderCaseLawFreshnessSessionLock({
              connection,
              database: db,
              read: readCaseLawFreshnessReportTx,
            });
            if (locked.status === "skipped") {
              return false;
            }
            result = locked.value;
            return true;
          },
          read: () =>
            Promise.resolve(
              result ??
                panic("Case-law freshness report was not read under its lock"),
            ),
        });
      },
    );
  });
};

export const startCaseLawFreshnessMetricLoop = (): (() => Promise<void>) => {
  if (isLocalTestRun()) {
    return () => Promise.resolve();
  }
  return startNonOverlappingInterval({
    intervalMs: REPORT_INTERVAL_MS,
    onError: (error) => {
      observeFailure(error, {
        sink: FRESHNESS_METRICS_SINK,
        ctx: { source: "case-law-freshness-metrics" },
      });
    },
    run: runProductionTick,
  });
};
