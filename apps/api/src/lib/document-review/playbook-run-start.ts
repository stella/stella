/**
 * What starting the extraction workflow means for a playbook run.
 *
 * `openPlaybookRun` owns the transaction half of starting a review: the pin,
 * the columns, the durable runs. The other half happens after that
 * transaction commits, when the surface asks the queue to extract the columns
 * it just materialized. That call cannot move into the opener — jobs enqueued
 * inside the transaction could be claimed before it commits — so what its
 * result means lives here instead, in one place all four surfaces read.
 *
 * The distinction that matters: the queue reports an enqueue failure in band,
 * as a status, not as a throw. A surface that only catches exceptions answers
 * success for a review whose columns nothing will ever grade.
 */

import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";

/**
 * `queued`: the columns the run materialized are being extracted now.
 *
 * `deferred`: nothing was queued this time, because a run already holds the
 * workspace or the plan had no work left. The materialized columns are stale
 * ai-model columns either way, so the run in flight (or the next one) still
 * grades them, and reporting the review as started stays true.
 *
 * `not-started`: the enqueue failed. The columns exist and nothing is coming
 * for them until someone asks again, so no surface may report success.
 */
export const PLAYBOOK_RUN_START_OUTCOME = {
  QUEUED: "queued",
  DEFERRED: "deferred",
  NOT_STARTED: "not-started",
} as const;

export type PlaybookRunStartOutcome =
  (typeof PLAYBOOK_RUN_START_OUTCOME)[keyof typeof PLAYBOOK_RUN_START_OUTCOME];

const OUTCOME_BY_STATUS = {
  started: PLAYBOOK_RUN_START_OUTCOME.QUEUED,
  "already-running": PLAYBOOK_RUN_START_OUTCOME.DEFERRED,
  skipped: PLAYBOOK_RUN_START_OUTCOME.DEFERRED,
  failed: PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED,
} as const satisfies Record<WorkflowStartStatus, PlaybookRunStartOutcome>;

/** Classify a start status. Total over the queue's statuses, so a new one
 *  cannot be added without deciding what the run surfaces answer for it. */
export const playbookRunStartOutcome = (
  status: WorkflowStartStatus,
): PlaybookRunStartOutcome => OUTCOME_BY_STATUS[status];
