import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";
import { isUuid } from "@stll/uuid-codec";

import { schedulerJobs } from "@/api/db/schema";
import { maintenanceScopedDb } from "@/api/lib/db/maintenance-db";
import {
  censusCaseLawRawObjectsPage,
  RAW_CENSUS_MODE,
} from "@/api/lib/legal-search/case-law-raw-census";
import type { RawCensusCursor } from "@/api/lib/legal-search/case-law-raw-census";
import {
  RAW_LAYOUT_MODE,
  reconcileCaseLawRawLayoutPage,
} from "@/api/lib/legal-search/case-law-raw-layout";
import { reconcileCaseLawRawSweeps } from "@/api/lib/legal-search/case-law-raw-sweeps";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerJob, SchedulerTask } from "@/api/lib/scheduler/types";

/**
 * The three recurring passes that keep per-decision raw storage honest.
 * They run in the API process, whose role may list and delete raw objects;
 * the ingestion worker only records what it needs swept.
 */

export const RECONCILE_CASE_LAW_RAW_SWEEPS_TASK =
  "caseLaw.reconcileRawSweeps" as const;
export const RECONCILE_CASE_LAW_RAW_ROWS_TASK =
  "caseLaw.reconcileRawRows" as const;
export const CENSUS_CASE_LAW_RAW_OBJECTS_TASK =
  "caseLaw.censusRawObjects" as const;

const SWEEP_LIMIT = 20;
const ROW_PAGE_LIMIT = 200;
const CENSUS_PAGE_KEYS = 1000;
const CONTINUATION_DELAY_MS = 1000;

const leaseFence = (job: SchedulerJob) =>
  and(
    eq(schedulerJobs.id, job.id),
    eq(
      schedulerJobs.lockedBy,
      job.lockedBy ?? panic("Raw storage pass requires a scheduler lease"),
    ),
  );

/** Delete the raw prefixes owed a sweep: erased decisions, lost writes. */
export const reconcileCaseLawRawSweepsTask: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const result = await reconcileCaseLawRawSweeps({
    scopedDb: maintenanceScopedDb,
    limit: SWEEP_LIMIT,
    signal,
  });
  logger.info("scheduler.case_law_raw_sweeps_reconciled", {
    "caseLawRawSweeps.claimed": result.claimed,
    "caseLawRawSweeps.swept": result.swept,
    "caseLawRawSweeps.failed": result.failed,
    "caseLawRawSweeps.legacyPending": result.legacyPending,
  });
};

const parseRowCursor = (payload: Record<string, unknown> | null) => {
  const value = payload?.["cursor"] ?? null;
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !isUuid(value)) {
    return panic("Raw row pass cursor must be a UUID");
  }
  return brandPersistedCaseLawDecisionId(value);
};

/**
 * One page of the decisions table: rows in the older raw layout are moved
 * into their own prefix, and rows already there are checked. The walk wraps
 * at the end, so rows written in the older layout by a task that had not
 * yet been replaced are reached on a later pass.
 */
export const reconcileCaseLawRawRowsTask: SchedulerTask = async ({
  job,
  logger,
  scheduleContinuation,
  signal,
}) => {
  signal.throwIfAborted();
  const cursor = parseRowCursor(job.payload);
  const page = await reconcileCaseLawRawLayoutPage({
    scopedDb: maintenanceScopedDb,
    cursor,
    limit: ROW_PAGE_LIMIT,
    mode: RAW_LAYOUT_MODE.APPLY,
    signal,
  });
  // Checkpoint last, and only as far as every row before it is settled.
  await maintenanceScopedDb(
    async (tx) =>
      await tx
        .update(schedulerJobs)
        .set({ payload: { cursor: page.resumeAfter } })
        .where(leaseFence(job)),
  );
  logger.info("scheduler.case_law_raw_rows_reconciled", {
    "caseLawRawRows.current": page.counts.current,
    "caseLawRawRows.migrated": page.counts.migrated,
    "caseLawRawRows.overtaken": page.counts.overtaken,
    "caseLawRawRows.unmovable": page.counts.unmovable,
    "caseLawRawRows.dangling": page.counts.dangling,
    "caseLawRawRows.retry": page.counts.retry,
    "caseLawRawRows.copies": page.counts.copies,
    "caseLawRawRows.passComplete": page.resumeAfter === null,
  });
  for (const { decisionId, outcome } of page.reported) {
    logger.warn("case_law.raw_storage.row_unreconciled", {
      decisionId,
      outcome,
    });
  }
  // A page that moved decisions is the backfill still running: the next
  // page follows at once. A page that only checked waits for the schedule.
  if (
    page.counts.migrated > 0 &&
    page.resumeAfter !== null &&
    !signal.aborted
  ) {
    scheduleContinuation(
      new Date(
        Temporal.Now.instant().epochMilliseconds + CONTINUATION_DELAY_MS,
      ),
    );
  }
};

const parseCensusCursor = (
  payload: Record<string, unknown> | null,
): RawCensusCursor | null => {
  const sourceId = payload?.["sourceId"] ?? null;
  const startAfter = payload?.["startAfter"] ?? null;
  if (sourceId === null) {
    return null;
  }
  if (typeof sourceId !== "string" || !isUuid(sourceId)) {
    return panic("Raw census cursor source must be a UUID");
  }
  if (startAfter !== null && typeof startAfter !== "string") {
    return panic("Raw census cursor key must be a string");
  }
  return { sourceId: brandPersistedCaseLawSourceId(sourceId), startAfter };
};

/**
 * One page of raw objects, source by source: prefixes whose decision is
 * erased or was never written are queued for a sweep.
 */
export const censusCaseLawRawObjectsTask: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const page = await censusCaseLawRawObjectsPage({
    scopedDb: maintenanceScopedDb,
    cursor: parseCensusCursor(job.payload),
    maxKeys: CENSUS_PAGE_KEYS,
    mode: RAW_CENSUS_MODE.APPLY,
    signal,
  });
  await maintenanceScopedDb(
    async (tx) =>
      await tx
        .update(schedulerJobs)
        .set({
          payload:
            page.next === null
              ? null
              : {
                  sourceId: page.next.sourceId,
                  startAfter: page.next.startAfter,
                },
        })
        .where(leaseFence(job)),
  );
  logger.info("scheduler.case_law_raw_objects_censused", {
    "caseLawRawObjects.live": page.counts.live,
    "caseLawRawObjects.reserved": page.counts.reserved,
    "caseLawRawObjects.erased": page.counts.erased,
    "caseLawRawObjects.orphaned": page.counts.orphaned,
    "caseLawRawObjects.recent": page.counts.recent,
    "caseLawRawObjects.unrecognized": page.counts.unrecognized,
    "caseLawRawObjects.queued": page.counts.queued,
    "caseLawRawObjects.passComplete": page.next === null,
  });
};
