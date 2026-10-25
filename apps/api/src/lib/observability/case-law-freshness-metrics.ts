import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawSources, corpusIndexProjectionStates } from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  readServingCorpusIndexGenerationTx,
  type ServingCorpusIndexGeneration,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexProjectionConvergenceTx } from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { corpusIndexProjectionNeedsWork } from "@/api/lib/legal-search/corpus-index-projection-sql";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  buildCaseLawOldestUnpublishedAgeMetric,
  buildCaseLawProjectionBacklogMetric,
  buildCaseLawProjectionConvergenceMetric,
  buildCaseLawSourceSyncAgeMetric,
  writeMetricLine,
} from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";

const SCHEDULED_SOURCE_KEYS = Object.values(ADAPTER_KEYS);

type CaseLawFreshnessReport = {
  /** Capped at `CASE_LAW_FRESHNESS_SCAN_CAP`. */
  backlogItems: number;
  /** Whether the queue held more rows than the report reads. */
  backlogCapped: boolean;
  oldestUnpublishedAgeSeconds: number;
  oldestUnpublishedAgeSource:
    "desired_at" | "state_created_at_fallback" | "none";
  sourceAges: readonly { source: string; ageSeconds: number }[];
  convergence: string | null;
};
const requiredNumber = (row: unknown, key: string): number => {
  if (!isRecord(row) || typeof row[key] !== "number") {
    return panic(`Malformed case-law freshness query result: ${key}`);
  }
  return row[key];
};

const requiredAgeSource = (
  row: unknown,
  key: string,
): CaseLawFreshnessReport["oldestUnpublishedAgeSource"] => {
  if (!isRecord(row)) {
    return panic(`Malformed case-law freshness query result: ${key}`);
  }
  const value = row[key];
  if (
    value !== "desired_at" &&
    value !== "state_created_at_fallback" &&
    value !== "none"
  ) {
    return panic(`Malformed case-law freshness query result: ${key}`);
  }
  return value;
};

/**
 * How many queued rows one report reads, at most. The report is a gauge: past
 * this many the backlog is reported as this many, already far past any
 * threshold a reader acts on, and the read stays a bounded walk of the queue
 * index however large the queue grows.
 */
export const CASE_LAW_FRESHNESS_SCAN_CAP = 10_000;

/**
 * The serving generation's unpublished backlog: its projection states that
 * still owe the engine work, walked in the projector's own queue order off
 * `corpus_index_projection_states_pending_idx` (the predicate is the index's
 * own, so the plan never falls back to the table), and capped one past the
 * cap so a full window is distinguishable from an exact count.
 *
 * The states queue is the whole backlog. The projector reserves a revision
 * only for a state it claimed from this queue, and the state leaves the queue
 * only once that revision is applied, so a revision in flight is already
 * counted through its state. Cleanup of a superseded revision changes nothing
 * readers are served; the convergence status reports it.
 */
export const caseLawFreshnessPendingStatesQuery = (
  target: ServingCorpusIndexGeneration,
) => {
  const states = corpusIndexProjectionStates;
  return sql`
    SELECT count(*)::int AS count,
      coalesce(extract(epoch FROM clock_timestamp() - min(pending_since)), 0)::float8 AS age,
      coalesce((array_agg(age_source ORDER BY pending_since))[1], 'none') AS age_source
    FROM (
      SELECT coalesce(${states.desiredAt}, ${states.createdAt}) AS pending_since,
        CASE WHEN ${states.desiredAt} IS NULL
          THEN 'state_created_at_fallback'
          ELSE 'desired_at'
        END AS age_source
      FROM ${states}
      WHERE ${states.family} = ${target.family}
        AND ${states.generation} = ${target.generation}
        AND ${corpusIndexProjectionNeedsWork(states)}
      ORDER BY coalesce(${states.retryNotBefore}, ${states.updatedAt}),
        ${states.entityId}
      LIMIT ${CASE_LAW_FRESHNESS_SCAN_CAP + 1}
    ) AS pending
  `;
};

const NO_BACKLOG = { count: 0, age: 0, ageSource: "none" } as const;

/**
 * What the serving generation still owes the engine. Only the serving
 * generation: a building or retired generation's queue is not what readers
 * are served, and counting every generation's history is what made the
 * report read the projection tables whole.
 */
const readServingBacklog = async (
  tx: Transaction,
  serving: ServingCorpusIndexGeneration | null,
) => {
  if (serving === null) {
    return NO_BACKLOG;
  }
  const row = executedRows(
    await tx.execute(caseLawFreshnessPendingStatesQuery(serving)),
  ).at(0);
  return {
    count: requiredNumber(row, "count"),
    age: requiredNumber(row, "age"),
    ageSource: requiredAgeSource(row, "age_source"),
  };
};

export const readCaseLawFreshnessReportTx = async (
  tx: Transaction,
): Promise<CaseLawFreshnessReport> => {
  const [sourceRows, serving] = await Promise.all([
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
  const servingTarget = Result.isOk(serving) ? serving.value : null;
  const backlog = await readServingBacklog(tx, servingTarget);
  const convergence =
    servingTarget === null
      ? null
      : await readCorpusIndexProjectionConvergenceTx(tx, servingTarget);
  return {
    backlogItems: Math.min(backlog.count, CASE_LAW_FRESHNESS_SCAN_CAP),
    backlogCapped: backlog.count > CASE_LAW_FRESHNESS_SCAN_CAP,
    oldestUnpublishedAgeSeconds: backlog.age,
    oldestUnpublishedAgeSource: backlog.ageSource,
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
