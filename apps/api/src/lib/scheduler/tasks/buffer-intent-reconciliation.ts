import { Result, panic } from "better-result";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { reconcileStaleBufferIntentsGlobally } from "@/api/lib/buffer-intent-reconciliation";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_BUFFER_INTENTS_TASK =
  "entityBuffers.reconcileIntents" as const;

const RECONCILE_INTENT_LIMIT = 50;

type ReconcileDependencies = {
  rootSafeDb?: SafeDb;
  reconcile?: typeof reconcileStaleBufferIntentsGlobally;
};

export const createReconcileBufferIntentsTask =
  ({
    rootSafeDb = async (run) =>
      await Result.tryPromise(async () => await rootDb.transaction(run)),
    reconcile = reconcileStaleBufferIntentsGlobally,
  }: ReconcileDependencies = {}): SchedulerTask =>
  /**
   * Independently drain abandoned server-generated file intents. This scheduled
   * sweep guarantees that a workspace never needs another write to reclaim
   * orphaned final-key S3 objects after a hard process death.
   */
  async ({ logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const claimedIntents = await reconcile({
      safeDb: rootSafeDb,
      limit: RECONCILE_INTENT_LIMIT,
      signal,
    });

    logger.info("scheduler.buffer_intents_reconciled", {
      "bufferIntents.claimed": claimedIntents,
    });
  };

export const reconcileBufferIntents = createReconcileBufferIntentsTask();
