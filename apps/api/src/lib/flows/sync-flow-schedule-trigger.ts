import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { AggregateIdentities } from "@/api/lib/db/aggregate-lock-entries/identities.gen";
import { errorTag } from "@/api/lib/errors/utils";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import { reconcileCommittedFlowSchedule } from "@/api/lib/scheduler/jobs";

/**
 * Reconcile the scheduler row for a definition's `schedule` trigger. Called
 * from the create / update / delete definition handlers after the write
 * commits, so exactly one `scheduler_jobs` row (task `flow.run`, keyed by
 * `flowScheduleJobId`) exists per enabled schedule-triggered definition:
 *
 * - enabled + `schedule` trigger -> upsert the row (idempotent).
 * - disabled, deleted, or trigger changed away from `schedule` -> remove it.
 *
 * Each reconciliation reads current committed state under the scheduler-owned
 * per-definition fence. Once successful reconcilers settle, the job matches the
 * definition. This remains post-commit best effort: errors are captured, and a
 * failed reconcile needs a later write to repair it.
 */
export const syncFlowScheduleTrigger = async ({
  id,
  organizationId,
}: AggregateIdentities["definition"]): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () =>
      await reconcileCommittedFlowSchedule({ id, organizationId }),
    catch: (cause) => cause,
  });

  if (Result.isError(result)) {
    captureError(
      result.error,
      handlerErrorContext("flows.syncFlowScheduleTrigger.result_error", {
        definitionId: id,
      }),
    );
    logger.error("flow.schedule_sync_failed", {
      definitionId: id,
      organizationId,
      "error.type": errorTag(result.error),
    });
  }
};
