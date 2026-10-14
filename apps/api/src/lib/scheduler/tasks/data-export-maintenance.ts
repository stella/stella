import { panic, Result } from "better-result";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

import {
  DATA_EXPORT_MAX_ATTEMPTS,
  organizationDataExports,
} from "@/api/db/schema";
import {
  DATA_EXPORT_HEARTBEAT_STALE_MS,
  dataExportPrefix,
  deleteDataExportObjects,
  enqueueDataExport,
} from "@/api/lib/data-export-queue";
import {
  brandPersistedDataExportId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const MAINTAIN_DATA_EXPORTS_TASK = "dataExports.maintain" as const;

/** Rows handled per state per tick; the next tick takes the rest. */
const BATCH_SIZE = 50;
/** A queued export older than this has lost its queue handoff. */
const QUEUED_HANDOFF_SETTLE_MS = 5 * 60 * 1000;
const STALE_RUN_ERROR =
  "The export stopped repeatedly before it finished. Please start a new export.";
const ABANDONED_ERROR =
  "The export could not be started because its requester's account no longer exists.";

export type DataExportMaintenanceDependencies = {
  deleteObjects: (prefix: string) => Promise<void>;
  enqueue: typeof enqueueDataExport;
};

type MaintenanceSummary = {
  expired: number;
  resumed: number;
  failedStale: number;
  requeued: number;
  errors: unknown[];
};

type StepArgs = {
  db: SchedulerDb;
  deps: DataExportMaintenanceDependencies;
  summary: MaintenanceSummary;
  /** The slot this run was due for; every cutoff derives from it. */
  now: Date;
};

// Cutoffs are compared in the database at timestamptz precision.
const atOrBefore = (column: AnyColumn, cutoff: Date) =>
  sql<boolean>`${column} <= ${cutoff.toISOString()}::timestamptz`;
const before = (column: AnyColumn, cutoff: Date) =>
  sql<boolean>`${column} < ${cutoff.toISOString()}::timestamptz`;

const expireReady = async ({ db, deps, summary, now }: StepArgs) => {
  const due = await db
    .select({
      id: organizationDataExports.id,
      organizationId: organizationDataExports.organizationId,
    })
    .from(organizationDataExports)
    .where(
      and(
        eq(organizationDataExports.status, "ready"),
        atOrBefore(organizationDataExports.expiresAt, now),
      ),
    )
    .orderBy(asc(organizationDataExports.expiresAt))
    .limit(BATCH_SIZE);
  for (const row of due) {
    // db-await-in-loop: one storage delete then one conditional update per expired export; bounded by BATCH_SIZE
    const deleted = await Result.tryPromise(
      async () =>
        await deps.deleteObjects(
          dataExportPrefix({
            organizationId: row.organizationId,
            exportId: row.id,
          }),
        ),
    );
    // Files first, row second: a row marked expired never still has files,
    // and a failed delete keeps the row `ready` for the next tick.
    if (Result.isError(deleted)) {
      summary.errors.push(deleted.error);
      continue;
    }
    // audit: skip - retention lifecycle of an export whose request and downloads are audited
    await db
      .update(organizationDataExports)
      .set({ status: "expired" })
      .where(
        and(
          eq(organizationDataExports.id, row.id),
          eq(organizationDataExports.status, "ready"),
        ),
      );
    summary.expired += 1;
  }
};

const resumeStaleRuns = async ({ db, deps, summary, now }: StepArgs) => {
  const staleBefore = new Date(now.getTime() - DATA_EXPORT_HEARTBEAT_STALE_MS);
  // A worker that vanished (crash, killed deploy) leaves its checkpoints:
  // hand the run back so the next attempt resumes, unless it is out of
  // attempts.
  // audit: skip - lifecycle bookkeeping for a run whose worker disappeared
  const resumed = await db
    .update(organizationDataExports)
    .set({ status: "queued" })
    .where(
      and(
        eq(organizationDataExports.status, "running"),
        before(organizationDataExports.heartbeatAt, staleBefore),
        lt(organizationDataExports.attempts, DATA_EXPORT_MAX_ATTEMPTS),
      ),
    )
    .returning({ id: organizationDataExports.id });
  summary.resumed += resumed.length;
  // audit: skip - terminal bookkeeping for a run out of attempts
  const failed = await db
    .update(organizationDataExports)
    .set({ status: "failed", error: STALE_RUN_ERROR, completedAt: now })
    .where(
      and(
        eq(organizationDataExports.status, "running"),
        before(organizationDataExports.heartbeatAt, staleBefore),
        gte(organizationDataExports.attempts, DATA_EXPORT_MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: organizationDataExports.id,
      organizationId: organizationDataExports.organizationId,
    });
  summary.failedStale += failed.length;
  for (const row of failed) {
    // db-await-in-loop: storage cleanup per failed run; rows are rare and the update above already committed
    const deleted = await Result.tryPromise(
      async () =>
        await deps.deleteObjects(
          dataExportPrefix({
            organizationId: row.organizationId,
            exportId: row.id,
          }),
        ),
    );
    if (Result.isError(deleted)) {
      summary.errors.push(deleted.error);
    }
  }
};

const requeueQueued = async ({ db, deps, summary, now }: StepArgs) => {
  const settledBefore = new Date(now.getTime() - QUEUED_HANDOFF_SETTLE_MS);
  const queued = await db
    .select({
      id: organizationDataExports.id,
      organizationId: organizationDataExports.organizationId,
      requestedBy: organizationDataExports.requestedBy,
      attempts: organizationDataExports.attempts,
    })
    .from(organizationDataExports)
    .where(
      and(
        eq(organizationDataExports.status, "queued"),
        before(organizationDataExports.createdAt, settledBefore),
      ),
    )
    .orderBy(asc(organizationDataExports.createdAt))
    .limit(BATCH_SIZE);
  for (const row of queued) {
    const requestedBy = row.requestedBy;
    if (requestedBy === null) {
      // audit: skip - an export whose requester was deleted cannot run as anyone
      // db-await-in-loop: one conditional update per abandoned row; bounded by BATCH_SIZE
      await db
        .update(organizationDataExports)
        .set({ status: "failed", error: ABANDONED_ERROR, completedAt: now })
        .where(
          and(
            eq(organizationDataExports.id, row.id),
            eq(organizationDataExports.status, "queued"),
          ),
        );
      continue;
    }
    // Idempotent: the job id derives from the export and its attempt count,
    // so a row still waiting for a free slot is not queued twice.
    // db-await-in-loop: one idempotent queue handoff per queued export; bounded by BATCH_SIZE
    const handedOff = await Result.tryPromise(
      async () =>
        await deps.enqueue({
          exportId: brandPersistedDataExportId(row.id),
          organizationId: brandPersistedOrganizationId(row.organizationId),
          userId: brandPersistedUserId(requestedBy),
          attempts: row.attempts,
        }),
    );
    if (Result.isError(handedOff)) {
      summary.errors.push(handedOff.error);
      continue;
    }
    summary.requeued += 1;
  }
};

/**
 * Keep exports moving and honest about their files: delete the files of
 * expired exports, resume runs whose worker stopped (failing those out of
 * attempts), and enqueue queued exports, which is how a stopped run gets its
 * next attempt.
 */
export const createMaintainDataExportsTask =
  (deps: DataExportMaintenanceDependencies): SchedulerTask =>
  async ({ db, dueAt, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const summary: MaintenanceSummary = {
      expired: 0,
      resumed: 0,
      failedStale: 0,
      requeued: 0,
      errors: [],
    };
    const step = { db, deps, summary, now: dueAt.toDate() };
    await expireReady(step);
    await resumeStaleRuns(step);
    await requeueQueued(step);
    logger.info("scheduler.data_exports_maintained", {
      "dataExports.expired": summary.expired,
      "dataExports.resumed": summary.resumed,
      "dataExports.failedStale": summary.failedStale,
      "dataExports.requeued": summary.requeued,
      "dataExports.errors": summary.errors.length,
    });
    const firstError = summary.errors.at(0);
    if (firstError !== undefined) {
      return Result.err(
        new SchedulerTaskFailure({
          cause: firstError,
          message: `${summary.errors.length} data export maintenance step(s) failed`,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const maintainDataExports = createMaintainDataExportsTask({
  deleteObjects: deleteDataExportObjects,
  enqueue: enqueueDataExport,
});
