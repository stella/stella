import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { countTodaysAutomatedFlowRuns } from "@/api/lib/flows/automated-run-cap";
import { isAutomatedRunCapReached } from "@/api/lib/flows/flow-trigger-logic";
import type { FlowTriggerSource } from "@/api/lib/flows/flow-types";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import { logger } from "@/api/lib/observability/logger";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * Shared tail for both automated triggers (schedule + file-upload): guarantee
 * an actor, enforce the daily spend cap, then start the run. Fire-and-forget by
 * design — it never throws and never surfaces to the upload / scheduler caller;
 * every skip or failure is captured through the structured logger.
 *
 * Actor guarantee: an automated run is credited to the definition's author
 * (`createdByUserId`). If the author was deleted (`null`), the run is skipped
 * here so it can never reach the executor with an unresolvable actor.
 */
export type StartAutomatedFlowRunArgs = {
  definitionId: SafeId<"flowDefinition">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** Definition author; `null` when the creator was deleted. */
  createdByUserId: string | null;
  triggerSource: Extract<
    FlowTriggerSource,
    { type: "schedule" | "file-upload" }
  >;
  inputEntityIds: SafeId<"entity">[];
  /** Optional BullMQ delay for step 0 (file-upload defers past extraction). */
  enqueueDelayMs?: number;
  /** String-only structured-log context (definitionId, workspaceId, ...). */
  logContext: Record<string, string>;
};

export const startAutomatedFlowRun = async ({
  definitionId,
  organizationId,
  workspaceId,
  createdByUserId,
  triggerSource,
  inputEntityIds,
  enqueueDelayMs,
  logContext,
}: StartAutomatedFlowRunArgs): Promise<void> => {
  if (createdByUserId === null) {
    logger.warn("flow.automated_run_skipped_no_actor", logContext);
    return;
  }

  const countResult = await Result.tryPromise({
    try: async () => await countTodaysAutomatedFlowRuns(definitionId),
    catch: (cause) => cause,
  });
  if (Result.isError(countResult)) {
    captureError(countResult.error, logContext);
    logger.error("flow.automated_run_cap_check_failed", {
      ...logContext,
      "error.type": errorTag(countResult.error),
    });
    return;
  }
  // Best-effort guard: two concurrent uploads can both pass the check and
  // overshoot the cap by one. That is acceptable for a spend rail.
  if (isAutomatedRunCapReached(countResult.value)) {
    logger.info("flow.automated_run_capped", {
      ...logContext,
      dailyRunCount: countResult.value,
    });
    return;
  }

  const actorUserId = brandPersistedUserId(createdByUserId);
  const safeDb = createRootSafeDb({
    organizationId,
    userId: actorUserId,
    workspaceIds: [workspaceId],
  });

  const started = await startFlowRun({
    safeDb,
    organizationId,
    workspaceId,
    definitionId,
    triggerSource,
    inputEntityIds,
    ...(enqueueDelayMs !== undefined && { enqueueDelayMs }),
  });
  if (Result.isError(started)) {
    captureError(started.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(started.error),
    });
    return;
  }

  logger.info("flow.automated_run_started", {
    ...logContext,
    runId: started.value.runId,
    triggerType: triggerSource.type,
  });
};
