import { panic } from "better-result";

import { recoverDocumentDeadlineScoutDispatches } from "@/api/lib/document-processing-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK =
  "documentProcessing.recoverDeadlineScouts" as const;

/**
 * Dispatch document deadline scouts nothing has picked up.
 *
 * The scout worker starts with the API server, but the only driver of this
 * sweep was the document processing worker's reconciliation loop, so a
 * `pending` scout accumulated in every deployment shape without that process.
 * The scheduler runs wherever the API does, which is where the scouts are
 * consumed.
 */
export const recoverDocumentDeadlineScouts: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { count, hasMore } = await recoverDocumentDeadlineScoutDispatches();
  logger.info("scheduler.document_deadline_scouts_recovered", {
    "documentDeadlineScouts.dispatched": count,
    "documentDeadlineScouts.hasMore": hasMore,
  });
};
