/**
 * What the workspace workflow-start endpoint does with each way a start
 * attempt can end.
 *
 * The queue reports an enqueue failure in band, as a status, not as a throw,
 * so an endpoint that hands the queue's answer back verbatim replies 200 for a
 * workflow nothing will ever run, and every client that reads a 2xx as success
 * reports the extraction as started. Classifying the whole status set here
 * keeps that decision in one place and forces a new queue status to pick a
 * side before it can reach the wire.
 */

import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";

/**
 * `report`: nothing failed, and the status itself is the answer. `started`
 * queued the work. `already-running` and `skipped` queued nothing this time,
 * because a run already holds the workspace or no stale cell was left to
 * extract; either way the cells belong to the run in flight or the next one,
 * so the caller has no failure to handle.
 *
 * `reject`: the enqueue failed. Nothing is coming for the cells until someone
 * asks again, so the endpoint must answer an error status.
 */
const WORKFLOW_START_DISPOSITION = {
  REPORT: "report",
  REJECT: "reject",
} as const;

type WorkflowStartDisposition =
  (typeof WORKFLOW_START_DISPOSITION)[keyof typeof WORKFLOW_START_DISPOSITION];

const DISPOSITION_BY_STATUS = {
  started: WORKFLOW_START_DISPOSITION.REPORT,
  "already-running": WORKFLOW_START_DISPOSITION.REPORT,
  skipped: WORKFLOW_START_DISPOSITION.REPORT,
  failed: WORKFLOW_START_DISPOSITION.REJECT,
} as const satisfies Record<WorkflowStartStatus, WorkflowStartDisposition>;

/**
 * The statuses a success body may carry, derived from the map so a status that
 * changes disposition leaves the response type with it.
 */
type ReportedWorkflowStartStatus = {
  [Status in WorkflowStartStatus]: (typeof DISPOSITION_BY_STATUS)[Status] extends typeof WORKFLOW_START_DISPOSITION.REPORT
    ? Status
    : never;
}[WorkflowStartStatus];

export const isReportedWorkflowStartStatus = (
  status: WorkflowStartStatus,
): status is ReportedWorkflowStartStatus =>
  DISPOSITION_BY_STATUS[status] === WORKFLOW_START_DISPOSITION.REPORT;
