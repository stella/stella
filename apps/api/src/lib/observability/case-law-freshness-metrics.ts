import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawSources, corpusIndexProjectionStates } from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { readServedCorpusIndexGenerationsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
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

type PendingSinceSource = "desired_at" | "state_created_at_fallback";

/**
 * How long the oldest unpublished state has waited.
 *
 * `incomplete` when the queue is longer than the report reads: the window is
 * the first rows in queue order (retry or update time), and the state pending
 * longest can sit beyond it after a later retry, so the window's oldest is not
 * the queue's. No index orders the queue by when work became pending, and a
 * gauge is not worth another index on the projection table's hottest write
 * path; the report says it cannot tell rather than publishing a younger age.
 */
export type CaseLawOldestUnpublishedAge =
  | { type: "measured"; seconds: number; source: PendingSinceSource }
  | { type: "no-backlog" }
  | { type: "incomplete" };

type CaseLawFreshnessReport = {
  /** Capped at `CASE_LAW_FRESHNESS_SCAN_CAP`. */
  backlogItems: number;
  /** Whether the queue held more rows than the report reads. */
  backlogCapped: boolean;
  oldestUnpublishedAge: CaseLawOldestUnpublishedAge;
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
): PendingSinceSource | "none" => {
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
export const caseLawFreshnessPendingStatesQuery = (target: {
  family: CorpusFamily;
  generation: string;
}) => {
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

type GenerationBacklog = {
  count: number;
  age: number;
  ageSource: PendingSinceSource | "none";
};

const NO_BACKLOG: GenerationBacklog = { count: 0, age: 0, ageSource: "none" };

/**
 * What the generations readers are served from still owe the engine: the
 * family's serving generation and every generation a jurisdiction was flipped
 * to, the set the read path resolves (`readServedCorpusIndexGenerationsTx`).
 * A building or retired generation nobody reads is not counted; counting
 * every generation's history is what made the report read the projection
 * tables whole. Each generation is one bounded walk of its queue, so the
 * report reads at most the cap per served generation.
 */
const readServedBacklog = async (
  tx: Transaction,
  generations: readonly string[],
): Promise<GenerationBacklog & { capped: boolean }> => {
  const backlogs = await Promise.all(
    generations.map(async (generation): Promise<GenerationBacklog> => {
      const row = executedRows(
        await tx.execute(
          caseLawFreshnessPendingStatesQuery({
            family: "case_law",
            generation,
          }),
        ),
      ).at(0);
      return {
        count: requiredNumber(row, "count"),
        age: requiredNumber(row, "age"),
        ageSource: requiredAgeSource(row, "age_source"),
      };
    }),
  );
  let count = 0;
  let oldest = NO_BACKLOG;
  for (const backlog of backlogs) {
    count += backlog.count;
    if (backlog.ageSource !== "none" && backlog.age >= oldest.age) {
      oldest = backlog;
    }
  }
  return {
    count,
    age: oldest.age,
    ageSource: oldest.ageSource,
    capped:
      count > CASE_LAW_FRESHNESS_SCAN_CAP ||
      backlogs.some((backlog) => backlog.count > CASE_LAW_FRESHNESS_SCAN_CAP),
  };
};

const oldestUnpublishedAgeOf = (
  backlog: { age: number; ageSource: PendingSinceSource | "none" },
  capped: boolean,
): CaseLawOldestUnpublishedAge => {
  if (capped) {
    return { type: "incomplete" };
  }
  return backlog.ageSource === "none"
    ? { type: "no-backlog" }
    : { type: "measured", seconds: backlog.age, source: backlog.ageSource };
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
    readServedCorpusIndexGenerationsTx(tx, "case_law"),
  ]);
  const served = Result.isOk(serving) ? serving.value : null;
  const backlog =
    served === null
      ? { ...NO_BACKLOG, capped: false }
      : await readServedBacklog(tx, [
          ...new Set([
            served.serving.generation,
            ...served.flipped.map(([, generation]) => generation),
          ]),
        ]);
  const convergence =
    served === null
      ? null
      : await readCorpusIndexProjectionConvergenceTx(tx, served.serving);
  return {
    backlogItems: Math.min(backlog.count, CASE_LAW_FRESHNESS_SCAN_CAP),
    backlogCapped: backlog.capped,
    oldestUnpublishedAge: oldestUnpublishedAgeOf(backlog, backlog.capped),
    sourceAges: sourceRows,
    convergence,
  };
};

export const emitCaseLawFreshnessReport = (
  report: CaseLawFreshnessReport,
): void => {
  writeMetricLine(buildCaseLawProjectionBacklogMetric(report.backlogItems));
  // An incomplete age emits nothing: a lower bound under the same metric
  // would read as the backlog's true age. The backlog metric at the cap
  // already says the queue is long.
  switch (report.oldestUnpublishedAge.type) {
    case "measured":
      writeMetricLine(
        buildCaseLawOldestUnpublishedAgeMetric(
          report.oldestUnpublishedAge.seconds,
        ),
      );
      break;
    case "no-backlog":
      writeMetricLine(buildCaseLawOldestUnpublishedAgeMetric(0));
      break;
    case "incomplete":
      break;
    default:
      report.oldestUnpublishedAge satisfies never;
      panic("Unhandled oldest unpublished age");
  }
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
