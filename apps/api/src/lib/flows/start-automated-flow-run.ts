import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import { captureError } from "@/api/lib/analytics/capture";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { insertAutomatedFlowRunWithinCap } from "@/api/lib/flows/automated-run-cap";
import { enqueueFlowStep } from "@/api/lib/flows/flow-run-queue";
import type { FlowTriggerSource } from "@/api/lib/flows/flow-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * Shared tail for both automated triggers (schedule + file-upload): guarantee
 * an actor, then insert the run under the daily spend cap atomically and
 * enqueue its first step. Fire-and-forget by design — it never throws and never
 * surfaces to the upload / scheduler caller; every skip or failure is captured
 * through the structured logger.
 *
 * Actor guarantee: an automated run is credited to the definition's author
 * (`createdByUserId`). If the author was deleted (`null`), the run is skipped
 * here so it can never reach the executor with an unresolvable actor.
 *
 * Cap atomicity: the count-and-insert is a single atomic decision (see
 * `insertAutomatedFlowRunWithinCap`), so two concurrent triggers can no longer
 * both pass the check and overshoot `MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY`.
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

  // Snapshot fields (name, steps) come from a root read: the automated triggers
  // run in a background context and the cap is an org-wide rail.
  const definitionResult = await Result.tryPromise({
    try: async () =>
      await rootDb.query.flowDefinitions.findFirst({
        where: {
          id: { eq: definitionId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, name: true, steps: true, enabled: true },
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(definitionResult)) {
    captureError(definitionResult.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(definitionResult.error),
    });
    return;
  }
  const definition = definitionResult.value;
  if (!definition) {
    logger.info("flow.automated_run_definition_missing", logContext);
    return;
  }
  if (!definition.enabled) {
    logger.info("flow.automated_run_definition_disabled", logContext);
    return;
  }

  // The run will execute as the author against a root-scoped grant for
  // `workspaceId` (see flow-executor), so nothing downstream re-checks that the
  // author may act in that matter. A file-upload trigger saved with
  // `workspaceIds: null` ("all matters") in particular reaches here for uploads
  // in matters the author never had access to. Gate the start on the author's
  // live workspace access, using the same membership / admin-bypass rule as the
  // request-time workspace guard, so an automated run can only touch matters its
  // actor is authorized for.
  const authorization = await Result.tryPromise({
    try: async () =>
      await resolveMemberAuthorization({
        organizationId,
        userId: brandPersistedUserId(createdByUserId),
        workspaceId,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(authorization)) {
    captureError(authorization.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(authorization.error),
    });
    return;
  }
  if (authorization.value === null || authorization.value.workspace === null) {
    logger.warn("flow.automated_run_actor_unauthorized", logContext);
    return;
  }

  const runId = createSafeId<"flowRun">();
  const rows = buildFlowRunRows({
    runId,
    workspaceId,
    definitionId,
    definition: { name: definition.name, steps: definition.steps },
    triggerSource,
    inputEntityIds,
  });

  const insertResult = await Result.tryPromise({
    try: async () =>
      await insertAutomatedFlowRunWithinCap({ definitionId, rows }),
    catch: (cause) => cause,
  });
  if (Result.isError(insertResult)) {
    captureError(insertResult.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(insertResult.error),
    });
    return;
  }
  if (insertResult.value.outcome === "capped") {
    logger.info("flow.automated_run_capped", {
      ...logContext,
      dailyRunCount: insertResult.value.dailyRunCount,
    });
    return;
  }

  // Enqueue after the rows commit. A failure here leaves the run `pending`; the
  // worker's boot reconciler re-enqueues its current step, so the run is never
  // permanently stranded.
  const enqueued = await Result.tryPromise({
    try: async () =>
      await enqueueFlowStep({
        runId,
        stepIndex: 0,
        ...(enqueueDelayMs !== undefined && { delayMs: enqueueDelayMs }),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(enqueued)) {
    captureError(enqueued.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(enqueued.error),
    });
    return;
  }

  logger.info("flow.automated_run_started", {
    ...logContext,
    runId,
    triggerType: triggerSource.type,
  });
};
