/**
 * Queue identity for view→report exports: the names, the job payload, the
 * handoff, and the sweep that hands an export back when nothing owns it.
 *
 * Separate from the worker in the reports handler slice so the scheduler can
 * drive the sweep without importing a handler, and so a caller that only needs
 * to enqueue does not pull in the fill pipeline. The worker imports the queue
 * name and payload from here; nothing here imports the worker.
 */

import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { reportExports, workspaces } from "@/api/db/schema";
import type { ReportExportFormat } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";

export const REPORT_EXPORT_QUEUE_NAME = "report-exports";
const REPORT_EXPORT_JOB_NAME = "export-report";
// One attempt: the fill runs metered AI and (in workspace mode) creates a
// document; a BullMQ retry would double both. Failures are persisted on the row.
const JOB_ATTEMPTS = 1;

export type ReportExportJobData = {
  exportId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
  format: ReportExportFormat;
  /** Include AI-drafted narrative sections: the worker needs it to gate the AI
   *  generators + template sections. Optional for back-compat with jobs
   *  enqueued before this field existed; absent means "on". */
  aiNarrative?: boolean;
};

type EnqueueReportExportArgs = {
  exportId: SafeId<"reportExport">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  format: ReportExportFormat;
  aiNarrative: boolean;
};

export const getReportExportQueue = createLazyBullMqQueue<ReportExportJobData>({
  name: REPORT_EXPORT_QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const enqueueReportExport = async ({
  exportId,
  workspaceId,
  organizationId,
  userId,
  format,
  aiNarrative,
}: EnqueueReportExportArgs): Promise<void> => {
  await getReportExportQueue().add(
    REPORT_EXPORT_JOB_NAME,
    { exportId, workspaceId, organizationId, userId, format, aiNarrative },
    { jobId: createBullMqJobId(workspaceId, exportId) },
  );
};

/** The (timestamp, id) keyset this sweep's walk pages on. */
const reportExportCursorCodec = createTimestampIdCursorCodec({
  column: reportExports.createdAt,
  brandId: brandPersistedReportExportId,
});

type QueuedReportExportRow = {
  aiNarrative: boolean | null;
  createdCursor: string;
  format: ReportExportFormat | null;
  id: SafeId<"reportExport">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

type ReconcileQueuedReportExportsOptions = {
  db?: Pick<typeof rootDb, "select" | "update">;
  queue?: RequeueableQueue<ReportExportJobData>;
};

/** Shown to the requester when the row cannot say what to run. */
const UNRECORDED_REQUEST_ERROR =
  "This export was queued before its options were recorded and cannot be restarted. Please run it again.";

type ReconcileQueuedReportExportsResult = ReconcileScanResult & {
  /**
   * `requested_by` is nulled when the requester's account is deleted, and the
   * job carries an actor. Counted rather than dropped quietly, so a population
   * this sweep cannot repair stays visible; the staleness janitor fails those
   * rows once they age out.
   */
  unattributed: number;
  /**
   * Rows queued before `format`/`ai_narrative` existed, whose request lived
   * only on a job the queue no longer has. Guessing the missing options would
   * run a different export than the one asked for, so these are failed here
   * instead: the requester is told to run it again rather than left polling a
   * row nothing will ever pick up.
   */
  unrecoverable: number;
};

/**
 * Hand `queued` exports back to the queue when nothing owns them anymore.
 *
 * The row is created inside the request's transaction and the job is added
 * after it commits, so a crash in between — or a queue that lost its waiting
 * jobs — leaves an export no worker will ever pick up, and the row cannot tell
 * that apart from one still waiting its turn. Re-adding is safe to repeat: the
 * job id is derived from the export id and only a `queued` row runs, so a
 * duplicate delivery is a no-op rather than a second metered fill.
 *
 * The walk pages forward on a keyset cursor rather than re-reading one fixed
 * page: an export the queue still owns keeps its `queued` row, so a sweep
 * bounded by the first page would inspect the same healthy backlog every tick
 * and never reach the orphan behind it.
 *
 * The owning organization is joined from the workspace rather than read off
 * the export: the request took it from the session, and the workspace is the
 * only durable record of which organization the export belongs to.
 *
 * A row whose request was never recorded is failed rather than handed back.
 * Those predate the columns and kept their options on the job alone, so the
 * sweep has nothing to rebuild from and any default it picked could run a
 * different export than the one asked for.
 */
export const reconcileQueuedReportExports = async ({
  db = rootDb,
  queue = getReportExportQueue(),
}: ReconcileQueuedReportExportsOptions = {}): Promise<ReconcileQueuedReportExportsResult> => {
  let unattributed = 0;
  let unrecoverable = 0;

  const after = (cursor: QueuedReportExportRow | null) => {
    if (cursor === null) {
      return undefined;
    }
    return reportExportCursorCodec.keysetAfter({
      cursor: {
        timestamp: reconcileCursorTimestamp(cursor.createdCursor),
        id: cursor.id,
      },
      idColumn: reportExports.id,
      direction: "ascending",
    });
  };

  const readPage = async (cursor: QueuedReportExportRow | null) =>
    await db
      .select({
        aiNarrative: reportExports.aiNarrative,
        createdCursor: reportExportCursorCodec.cursorValue,
        format: reportExports.format,
        id: reportExports.id,
        organizationId: workspaces.organizationId,
        requestedBy: reportExports.requestedBy,
        workspaceId: reportExports.workspaceId,
      })
      .from(reportExports)
      .innerJoin(workspaces, eq(workspaces.id, reportExports.workspaceId))
      .where(and(eq(reportExports.status, "queued"), after(cursor)))
      .orderBy(asc(reportExports.createdAt), asc(reportExports.id))
      .limit(RECONCILE_SCAN_PAGE_SIZE);

  const handle = async (row: QueuedReportExportRow): Promise<boolean> => {
    const { aiNarrative, format, requestedBy } = row;
    if (requestedBy === null) {
      unattributed += 1;
      return false;
    }
    if (format === null || aiNarrative === null) {
      unrecoverable += 1;
      // audit: skip — terminal bookkeeping on the already-audited export row.
      // Guarded on `queued` so a row a worker claimed in the meantime keeps
      // the state that worker is driving.
      await db
        .update(reportExports)
        .set({ status: "failed", error: UNRECORDED_REQUEST_ERROR })
        .where(
          and(eq(reportExports.id, row.id), eq(reportExports.status, "queued")),
        );
      return false;
    }
    const outcome = await Result.tryPromise({
      try: async () =>
        await requeueDeterministicJob({
          data: {
            exportId: row.id,
            workspaceId: row.workspaceId,
            organizationId: row.organizationId,
            userId: requestedBy,
            format,
            aiNarrative,
          },
          jobId: createBullMqJobId(row.workspaceId, row.id),
          name: REPORT_EXPORT_JOB_NAME,
          queue,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(outcome)) {
      captureError(outcome.error, { exportId: row.id });
      return false;
    }
    return outcome.value === QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  const scan = await scanPendingRows({ handle, readPage });
  return { ...scan, unattributed, unrecoverable };
};
