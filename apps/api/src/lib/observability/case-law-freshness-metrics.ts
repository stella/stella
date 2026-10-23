import { panic, Result } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawSources,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { readCorpusIndexProjectionConvergenceTx } from "@/api/lib/legal-search/corpus-index-projection-convergence";
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
  backlogItems: number;
  oldestUnpublishedAgeSeconds: number;
  oldestUnpublishedAgeSource:
    "desired_at" | "state_created_at_fallback" | "intent_created_at" | "none";
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
    value !== "intent_created_at" &&
    value !== "none"
  ) {
    return panic(`Malformed case-law freshness query result: ${key}`);
  }
  return value;
};

export const readCaseLawFreshnessReportTx = async (
  tx: Transaction,
): Promise<CaseLawFreshnessReport> => {
  const pendingState = sql`${corpusIndexProjectionStates.desiredEpoch} > coalesce(${corpusIndexProjectionStates.appliedEpoch}, -1)`;
  const [stateRows, intentRows, sourceRows, serving] = await Promise.all([
    tx.execute(sql`WITH pending AS (
      SELECT coalesce(${corpusIndexProjectionStates.desiredAt}, ${corpusIndexProjectionStates.createdAt}) AS pending_since,
        CASE WHEN ${corpusIndexProjectionStates.desiredAt} IS NULL
          THEN 'state_created_at_fallback'
          ELSE 'desired_at'
        END AS age_source
      FROM ${corpusIndexProjectionStates}
      WHERE ${corpusIndexProjectionStates.family} = 'case_law' AND ${pendingState}
    )
    SELECT count(*)::int AS count,
      coalesce(extract(epoch FROM clock_timestamp() - min(pending_since)), 0)::float8 AS age,
      coalesce((array_agg(age_source ORDER BY pending_since))[1], 'none') AS age_source
    FROM pending`),
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
  let oldestUnpublishedAgeSource: CaseLawFreshnessReport["oldestUnpublishedAgeSource"] =
    "none";
  if (
    stateCount > 0 &&
    requiredNumber(state, "age") >= requiredNumber(intent, "age")
  ) {
    oldestUnpublishedAgeSource = requiredAgeSource(state, "age_source");
  } else if (intentCount > 0) {
    oldestUnpublishedAgeSource = "intent_created_at";
  }
  const convergence = Result.isOk(serving)
    ? await readCorpusIndexProjectionConvergenceTx(tx, serving.value)
    : null;
  return {
    backlogItems: stateCount + intentCount,
    oldestUnpublishedAgeSeconds: oldestAge,
    oldestUnpublishedAgeSource,
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
