import { panic, Result } from "better-result";

import type { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  CORPUS_FAMILIES,
  type CorpusFamily,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { readServedCorpusIndexGenerationsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  type CorpusProjectionUnservedCount,
  type CorpusProjectionUnservedCounts,
  type CorpusProjectionUnservedKind,
  type CorpusProjectionUnservedOldest,
  type CorpusProjectionUnservedReadError,
  readCorpusProjectionUnservedCountsTx,
} from "@/api/lib/legal-search/corpus-index-projection-unserved";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  buildCorpusProjectionUnservedMetric,
  writeMetricLine,
} from "@/api/lib/observability/request-metrics";

/**
 * Recurring gauge of the entities each served generation should serve and
 * does not (`corpus-index-projection-unserved.ts`), at risk and absent apart:
 * per kind one record for the generation and one per index that has any,
 * each with the count and the age of the oldest. Any non-zero count is a
 * defect worth an alarm; expected lag (first appends, queued upserts whose
 * old copy still answers) never enters it.
 */

export type CorpusProjectionUnservedReport = readonly {
  family: CorpusFamily;
  generation: string;
  counts: CorpusProjectionUnservedCounts;
}[];

const UNSERVED_KINDS = [
  "at_risk",
  "absent",
] as const satisfies readonly CorpusProjectionUnservedKind[];

const UNSERVED_REPORT_SINK = failureSink({
  event: "corpus_projection.unserved_report_failed",
  expected: [],
});

/**
 * Every generation readers are served from, in both families: the serving
 * generation and each one a jurisdiction was flipped to. A family with nothing
 * served has nothing to count.
 */
export const readCorpusProjectionUnservedReportTx = async (
  tx: Transaction,
): Promise<
  Result<CorpusProjectionUnservedReport, CorpusProjectionUnservedReadError>
> => {
  const report: CorpusProjectionUnservedReport[number][] = [];
  for (const family of CORPUS_FAMILIES) {
    // db-await-in-loop: the two corpus families, each read once
    const served = await readServedCorpusIndexGenerationsTx(tx, family);
    if (Result.isError(served)) {
      continue;
    }
    const generations = new Set([
      served.value.serving.generation,
      ...served.value.flipped.map(([, generation]) => generation),
    ]);
    for (const generation of generations) {
      // db-await-in-loop: two bounded reads per served generation; a family serves its serving generation and at most its declared partial ones
      const counts = await readCorpusProjectionUnservedCountsTx(tx, {
        family,
        generation,
      });
      if (Result.isError(counts)) {
        return counts;
      }
      report.push({ family, generation, counts: counts.value });
    }
  }
  return Result.ok(report);
};

const ageOf = (
  oldest: CorpusProjectionUnservedOldest,
  now: Temporal.Instant,
) => {
  switch (oldest.type) {
    case "exact":
      return {
        type: "measured" as const,
        seconds: Math.max(0, now.since(oldest.since).total("seconds")),
      };
    case "unknown":
      return { type: "unknown" as const };
    default:
      oldest satisfies never;
      return panic("Unhandled unserved projection age");
  }
};

/**
 * The generation's age is its oldest index's. A stopped walk with no index
 * listed knows no age, and a complete walk with none listed has no unserved
 * entity, so it reads zero.
 */
const generationAgeOf = (
  count: CorpusProjectionUnservedCount,
  now: Temporal.Instant,
) => {
  const ages = count.byIndex.map(({ oldest }) => ageOf(oldest, now));
  const measured = ages.flatMap((age) =>
    age.type === "measured" ? [age.seconds] : [],
  );
  if (
    measured.length !== ages.length ||
    (count.type === "at_least" && ages.length === 0)
  ) {
    return { type: "unknown" as const };
  }
  return { type: "measured" as const, seconds: Math.max(0, ...measured) };
};

export const emitCorpusProjectionUnservedReport = (
  report: CorpusProjectionUnservedReport,
  now: Temporal.Instant,
): void => {
  for (const { family, generation, counts } of report) {
    for (const kind of UNSERVED_KINDS) {
      const count = counts[kind];
      writeMetricLine(
        buildCorpusProjectionUnservedMetric({
          family,
          generation,
          kind,
          scope: { type: "generation" },
          entities: count.byIndex.reduce(
            (total, { count: entities }) => total + entities,
            0,
          ),
          countBound: count.type,
          oldestAge: generationAgeOf(count, now),
        }),
      );
      for (const { indexId, count: entities, oldest } of count.byIndex) {
        writeMetricLine(
          buildCorpusProjectionUnservedMetric({
            family,
            generation,
            kind,
            scope: { type: "index", indexId },
            entities,
            countBound: count.type,
            oldestAge: ageOf(oldest, now),
          }),
        );
      }
    }
  }
};

/** Telemetry only: a failed read is observed and emits no gauge, never zero. */
export const observeCorpusProjectionUnservedReportFailure = (
  error: unknown,
): void => {
  observeFailure(error, { sink: UNSERVED_REPORT_SINK });
};
