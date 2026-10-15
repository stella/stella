import { panic, Result } from "better-result";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  DATA_EXPORT_MAX_FAILURES,
  organizationDataExports,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DATA_EXPORT_HEARTBEAT_STALE_MS,
  enqueueDataExport,
} from "@/api/lib/data-export-queue";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { DATA_EXPORT_TRANSITIONS } from "@/api/lib/db/data-export-transition-spec";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { transition } from "@/api/lib/db/transitions";
import {
  brandPersistedDataExportId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const MAINTAIN_DATA_EXPORTS_TASK = "dataExports.maintain" as const;

/** Rows handled per state per tick; a continuation takes the rest. */
const BATCH_SIZE = 50;
const CONTINUATION_DELAY_MS = 1000;
/** A queued export older than this has lost its queue handoff. */
const QUEUED_HANDOFF_SETTLE_MS = 5 * 60 * 1000;
const STALE_RUN_ERROR =
  "The export stopped repeatedly before it finished. Please start a new export.";
const ABANDONED_ERROR =
  "The export could not be started because its requester's account no longer exists.";

export type DataExportMaintenanceDependencies = {
  enqueue: typeof enqueueDataExport;
};

type MaintenanceSummary = {
  expired: number;
  resumed: number;
  failedStale: number;
  requeued: number;
  hasMore: boolean;
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

type SweepRow = {
  id: SafeId<"dataExport">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  attempt: number;
};

const sweepColumns = {
  id: organizationDataExports.id,
  organizationId: organizationDataExports.organizationId,
  requestedBy: organizationDataExports.requestedBy,
  attempt: organizationDataExports.attempt,
};

/** Audits one status change the sweep makes, for the export's organisation. */
const recordSweepChange =
  (row: SweepRow, reason: string) =>
  async (tx: Transaction, changed: { id: string; status: string }) => {
    const record = createBackgroundAuditRecorder({
      execution: {
        performer: {
          id: "data-export-maintenance",
          name: "Data export maintenance",
          type: "service",
        },
        trigger: { type: "system", source: MAINTAIN_DATA_EXPORTS_TASK },
      },
      organizationId: row.organizationId,
      workspaceId: null,
      userId: row.requestedBy ?? "data-export-maintenance",
    });
    await record(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
      resourceId: changed.id,
      metadata: { status: changed.status, reason },
    });
  };

/** Apply `move` to every row in its own short transaction; count the moved. */
const moveEach = async (
  db: SchedulerDb,
  rows: readonly SweepRow[],
  move: (tx: Transaction, row: SweepRow) => Promise<{ type: string }>,
  summary: MaintenanceSummary,
): Promise<number> => {
  const results = await Promise.all(
    rows.map(
      async (row) =>
        await Result.tryPromise(
          async () =>
            await withAggregateTransaction(
              db,
              async (tx: Transaction) => await move(tx, row),
            ),
        ),
    ),
  );
  let moved = 0;
  for (const result of results) {
    if (Result.isError(result)) {
      summary.errors.push(result.error);
      continue;
    }
    // A stale move means the row changed under the sweep; nothing to do.
    if (result.value.type === "transitioned") {
      moved += 1;
    }
  }
  return moved;
};

// The bucket lifecycle deletes export objects (the API role may not); this
// only stops offering them. `expires_at` counts from the run's start, which
// no object of the export predates, so a row turns `expired` no later than
// the lifecycle could remove its files and no link is ever signed for a
// removed object.
const expireReady = async ({ db, summary, now }: StepArgs) => {
  const duePage = await readCursorPage(
    db
      .select(sweepColumns)
      .from(organizationDataExports)
      .where(
        and(
          eq(organizationDataExports.status, "ready"),
          atOrBefore(organizationDataExports.expiresAt, now),
        ),
      )
      .orderBy(
        asc(organizationDataExports.expiresAt),
        asc(organizationDataExports.id),
      ),
    { limit: BATCH_SIZE, cursorForItem: (row) => row.id },
  );
  const due = duePage.items;
  summary.hasMore ||= duePage.nextCursor !== null;
  summary.expired += await moveEach(
    db,
    due,
    async (tx, row) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: row.id,
        options: { from: ["ready"], to: "expired", fence: row.attempt },
        recordTransitionAuditEvent: recordSweepChange(row, "expired"),
      }),
    summary,
  );
};

const resumeStaleRuns = async ({ db, summary, now }: StepArgs) => {
  const staleBefore = new Date(now.getTime() - DATA_EXPORT_HEARTBEAT_STALE_MS);
  const stalePage = await readCursorPage(
    db
      .select({ ...sweepColumns, failures: organizationDataExports.failures })
      .from(organizationDataExports)
      .where(
        and(
          eq(organizationDataExports.status, "running"),
          before(organizationDataExports.heartbeatAt, staleBefore),
        ),
      )
      .orderBy(
        asc(organizationDataExports.heartbeatAt),
        asc(organizationDataExports.id),
      ),
    { limit: BATCH_SIZE, cursorForItem: (row) => row.id },
  );
  const stale = stalePage.items;
  summary.hasMore ||= stalePage.nextCursor !== null;
  // A worker that vanished (crash, killed deploy) leaves its checkpoints:
  // hand the run back so the next attempt resumes. A lost worker counts as
  // a failure (a graceful stop hands itself back without one); an export
  // out of failures is failed. Both moves are fenced on the attempt seen
  // here, and a live old worker's writes stop matching once the row is no
  // longer `running` at its attempt.
  const resumable = stale.filter(
    (row) => row.failures < DATA_EXPORT_MAX_FAILURES - 1,
  );
  const exhausted = stale.filter(
    (row) => row.failures >= DATA_EXPORT_MAX_FAILURES - 1,
  );
  summary.resumed += await moveEach(
    db,
    resumable,
    async (tx, row) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: row.id,
        options: {
          from: ["running"],
          to: "queued",
          fence: row.attempt,
          set: { failures: sql`${organizationDataExports.failures} + 1` },
        },
        recordTransitionAuditEvent: recordSweepChange(row, "worker_lost"),
      }),
    summary,
  );
  // Parts already written age out through the bucket lifecycle.
  summary.failedStale += await moveEach(
    db,
    exhausted,
    async (tx, row) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: row.id,
        options: {
          from: ["running"],
          to: "failed",
          fence: row.attempt,
          set: { error: STALE_RUN_ERROR, completedAt: now },
        },
        recordTransitionAuditEvent: recordSweepChange(row, "out_of_attempts"),
      }),
    summary,
  );
};

const requeueQueued = async ({ db, deps, summary, now }: StepArgs) => {
  const settledBefore = new Date(now.getTime() - QUEUED_HANDOFF_SETTLE_MS);
  const settled = and(
    eq(organizationDataExports.status, "queued"),
    before(organizationDataExports.createdAt, settledBefore),
  );
  // An export whose requester's account was deleted cannot run as anyone.
  const abandonedPage = await readCursorPage(
    db
      .select(sweepColumns)
      .from(organizationDataExports)
      .where(and(settled, isNull(organizationDataExports.requestedBy)))
      .orderBy(
        asc(organizationDataExports.createdAt),
        asc(organizationDataExports.id),
      ),
    { limit: BATCH_SIZE, cursorForItem: (row) => row.id },
  );
  const abandoned = abandonedPage.items;
  summary.hasMore ||= abandonedPage.nextCursor !== null;
  await moveEach(
    db,
    abandoned,
    async (tx, row) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: row.id,
        options: {
          from: ["queued"],
          to: "failed",
          fence: row.attempt,
          set: { error: ABANDONED_ERROR, completedAt: now },
        },
        recordTransitionAuditEvent: recordSweepChange(row, "requester_deleted"),
      }),
    summary,
  );
  const queuedPage = await readCursorPage(
    db
      .select({
        id: organizationDataExports.id,
        organizationId: organizationDataExports.organizationId,
        requestedBy: organizationDataExports.requestedBy,
        attempt: organizationDataExports.attempt,
      })
      .from(organizationDataExports)
      .where(and(settled, isNotNull(organizationDataExports.requestedBy)))
      .orderBy(
        asc(organizationDataExports.createdAt),
        asc(organizationDataExports.id),
      ),
    { limit: BATCH_SIZE, cursorForItem: (row) => row.id },
  );
  const queued = queuedPage.items;
  summary.hasMore ||= queuedPage.nextCursor !== null;
  // Idempotent: the job id derives from the export and its attempt count,
  // so a row still waiting for a free slot is not queued twice.
  const handoffs = await Promise.all(
    queued.flatMap((row) => {
      const requestedBy = row.requestedBy;
      return requestedBy === null
        ? []
        : [
            Result.tryPromise(
              async () =>
                await deps.enqueue({
                  exportId: brandPersistedDataExportId(row.id),
                  organizationId: brandPersistedOrganizationId(
                    row.organizationId,
                  ),
                  userId: brandPersistedUserId(requestedBy),
                  attempt: row.attempt,
                }),
            ),
          ];
    }),
  );
  for (const handoff of handoffs) {
    if (Result.isError(handoff)) {
      summary.errors.push(handoff.error);
      continue;
    }
    summary.requeued += 1;
  }
};

/**
 * Keep exports moving: mark exports past their expiry as expired (the bucket
 * lifecycle deletes their files), resume runs whose worker stopped (failing those out of
 * attempts), and enqueue queued exports, which is how a stopped run gets its
 * next attempt.
 */
export const createMaintainDataExportsTask =
  (deps: DataExportMaintenanceDependencies): SchedulerTask =>
  async ({ db, dueAt, logger, signal, scheduleContinuation }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const summary: MaintenanceSummary = {
      expired: 0,
      resumed: 0,
      failedStale: 0,
      requeued: 0,
      hasMore: false,
      errors: [],
    };
    const step = { db, deps, summary, now: dueAt.toDate() };
    await expireReady(step);
    await resumeStaleRuns(step);
    await requeueQueued(step);
    // Transitions remove handled rows from the next scan; queue workers
    // remove handed-off rows when they claim them. The sentinel requests
    // another bounded pass without treating a full batch as complete.
    if (summary.hasMore) {
      scheduleContinuation(
        new Date(dueAt.claimedAtDate().getTime() + CONTINUATION_DELAY_MS),
      );
    }
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
  enqueue: enqueueDataExport,
});
