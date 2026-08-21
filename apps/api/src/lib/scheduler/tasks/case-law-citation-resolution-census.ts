import { panic } from "better-result";

import { rootDb } from "@/api/db/root";
import {
  type CensusDb,
  readCitationResolutionCensus,
  runCitationResolutionCensus,
} from "@/api/lib/case-law/citation-resolution-census";
import {
  CITATION_AMBIGUITY_SHAPE_DISPOSITION,
  CITATION_AMBIGUITY_SHAPES,
  CITATION_CENSUS_RULE_BUCKETS,
  CITATION_CENSUS_RUN_STATUS,
} from "@/api/lib/case-law/citation-resolution-census-consts";
import { CITATION_RESOLUTION_STATUS } from "@/api/lib/case-law/citation-resolution-status";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const CENSUS_CITATION_RESOLUTION_TASK =
  "caseLaw.censusCitationResolution" as const;

/** How many unruled (country, court, shape) groups one event names. */
export const CENSUS_EVENT_GROUP_LIMIT = 10;

/** How soon the next batch of a `scanning` run is taken. */
const CONTINUATION_DELAY_MS = 15_000;

const censusDb: CensusDb = async (fn) =>
  await rootDb.transaction(async (tx) => await fn(tx));

/**
 * Advance the census and report where resolution stands.
 *
 * A run still walking logs its progress and asks for a continuation; the event
 * below is written once, when the run completes. Every number in it is a
 * count from the snapshot:
 * totals by status, resolved totals by rule, ambiguous totals by shape, and
 * the largest groups among shapes no rule owns with their change against the
 * previous complete run. Groups are flattened to one attribute each because
 * the log carries scalars; the order is by citations, so the first few are
 * the ones that matter.
 */
export const censusCitationResolutionTask: SchedulerTask = async ({
  logger,
  scheduleContinuation,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }

  const run = await runCitationResolutionCensus({ db: censusDb, signal });
  if (run.status !== CITATION_CENSUS_RUN_STATUS.COMPLETE) {
    logger.info("scheduler.case_law_citation_resolution_census_advanced", {
      "citationCensus.run.status": run.status,
      "citationCensus.run.keysScanned": run.keysScanned,
      "citationCensus.run.keysScannedNow": run.keysScannedNow,
    });
    scheduleContinuation(new Date(Date.now() + CONTINUATION_DELAY_MS));
    return;
  }

  const report = await readCitationResolutionCensus({
    db: censusDb,
    limit: CENSUS_EVENT_GROUP_LIMIT,
  });

  const attributes: LoggerAttributes = {
    "citationCensus.run.keysScanned": run.keysScanned,
    "citationCensus.ambiguous":
      report.byStatus[CITATION_RESOLUTION_STATUS.AMBIGUOUS],
    "citationCensus.resolved":
      report.byStatus[CITATION_RESOLUTION_STATUS.RESOLVED],
    "citationCensus.unmatched":
      report.byStatus[CITATION_RESOLUTION_STATUS.UNMATCHED],
    "citationCensus.pending":
      report.byStatus[CITATION_RESOLUTION_STATUS.PENDING],
  };
  for (const rule of CITATION_CENSUS_RULE_BUCKETS) {
    attributes[`citationCensus.rule.${rule}`] = report.byRule[rule];
  }
  for (const shape of CITATION_AMBIGUITY_SHAPES) {
    attributes[`citationCensus.shape.${shape}`] = report.byShape[shape];
  }
  attributes["citationCensus.unruledShapes"] = CITATION_AMBIGUITY_SHAPES.filter(
    (shape) => CITATION_AMBIGUITY_SHAPE_DISPOSITION[shape].kind === "unruled",
  ).join(",");
  for (const [index, group] of report.unruled.entries()) {
    attributes[`citationCensus.unruled.${index}`] =
      `${group.country}|${group.court}|${group.shape}|keys=${group.keys}|citations=${group.citations}|delta=${group.delta ?? "n/a"}`;
  }

  logger.info("scheduler.case_law_citation_resolution_census", attributes);
};
