import { Result } from "better-result";

import type { rootDb } from "@/api/db/root";
import { captureError } from "@/api/lib/analytics/capture";
import type { resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/utils";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { insertAutomatedFlowRunWithinCap } from "@/api/lib/flows/automated-run-cap";
import type {
  InsertAutomatedFlowRunWithinCapInput,
  InsertAutomatedFlowRunWithinCapResult,
} from "@/api/lib/flows/automated-run-cap";
import { enqueueFlowStep } from "@/api/lib/flows/flow-run-queue";
import type {
  FlowTriggerSource,
  FlowUploadTriggerSkipReason,
} from "@/api/lib/flows/flow-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { QUEUED_ACTION_KIND } from "@/api/lib/rate-limit/action-kinds";
import { runQueuedKickoff } from "@/api/lib/rate-limit/queued-action-admission";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const AUTOMATED_RUN_START_FAILURE = failureSink({
  event: "flow.automated_run_start_failed",
  expected: [],
});

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

type FindFlowDefinitionArgs = {
  definitionId: SafeId<"flowDefinition">;
  organizationId: SafeId<"organization">;
};

type StartAutomatedFlowRunDependencies = {
  findDefinition: (args: FindFlowDefinitionArgs) => Promise<
    | {
        enabled: boolean;
        id: SafeId<"flowDefinition">;
        name: string;
        steps: Parameters<typeof buildFlowRunRows>[0]["definition"]["steps"];
      }
    | undefined
  >;
  resolveAuthorization: typeof resolveCredentialMemberAuthorization;
  featureEnabled: (args: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  }) => Promise<boolean>;
  insertWithinCap: (
    input: Omit<InsertAutomatedFlowRunWithinCapInput, "database">,
  ) => Promise<InsertAutomatedFlowRunWithinCapResult>;
  enqueueStep: typeof enqueueFlowStep;
  kickoff?: typeof runQueuedKickoff;
};

/**
 * The production dependencies, reading and inserting through the caller's
 * owner connection: the scheduler's for a schedule tick, the upload trigger's
 * for a file upload.
 */
export const automatedFlowRunDependencies = (
  database: Pick<typeof rootDb, "query" | "select" | "transaction">,
): StartAutomatedFlowRunDependencies => ({
  findDefinition: async ({
    definitionId,
    organizationId,
  }: FindFlowDefinitionArgs) =>
    await database.query.flowDefinitions.findFirst({
      where: {
        id: { eq: definitionId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, name: true, steps: true, enabled: true },
    }),
  featureEnabled: async (principal) =>
    await isBackgroundFeatureEnabled({
      tx: database,
      organizationId: principal.organizationId,
      userId: principal.userId,
      featureId: "flows",
    }),
  resolveAuthorization: async (lookup) =>
    await resolveMemberAuthorization(lookup, database),
  insertWithinCap: async (input) =>
    await insertAutomatedFlowRunWithinCap({ ...input, database }),
  enqueueStep: enqueueFlowStep,
});

export type StartAutomatedFlowRunOutcome =
  | { status: "paused" }
  | { status: "retry" }
  | { status: "skipped"; reason: FlowUploadTriggerSkipReason }
  | { status: "settled" };

export const startAutomatedFlowRun = async (
  {
    definitionId,
    organizationId,
    workspaceId,
    createdByUserId,
    triggerSource,
    inputEntityIds,
    enqueueDelayMs,
    logContext,
  }: StartAutomatedFlowRunArgs,
  {
    findDefinition,
    featureEnabled,
    resolveAuthorization,
    insertWithinCap,
    enqueueStep,
    kickoff = runQueuedKickoff,
  }: StartAutomatedFlowRunDependencies,
): Promise<StartAutomatedFlowRunOutcome> => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    logger.info("flow.automated_run_skipped", {
      ...logContext,
      reason: "deployment_disabled",
    });
    return { status: "paused" };
  }
  if (createdByUserId === null) {
    logger.warn("flow.automated_run_skipped_no_actor", logContext);
    return { status: "settled" };
  }

  // Snapshot fields (name, steps) come from a root read: the automated triggers
  // run in a background context and the cap is an org-wide rail.
  const admission = await Result.tryPromise(() =>
    featureEnabled({
      organizationId,
      userId: brandPersistedUserId(createdByUserId),
    }),
  );
  if (Result.isError(admission)) {
    observeFailure(admission.error, {
      sink: AUTOMATED_RUN_START_FAILURE,
      ctx: { workspaceId, organizationId },
    });
    return { status: "retry" };
  }
  if (!admission.value) {
    logger.info("flow.automated_run_skipped", {
      ...logContext,
      reason: "actor_not_granted",
    });
    return { status: "paused" };
  }
  const definitionResult = await Result.tryPromise({
    try: async () => await findDefinition({ definitionId, organizationId }),
    catch: (cause) => cause,
  });
  if (Result.isError(definitionResult)) {
    captureError(definitionResult.error, logContext);
    logger.error("flow.automated_run_start_failed", {
      ...logContext,
      "error.type": errorTag(definitionResult.error),
    });
    return { status: "retry" };
  }
  const definition = definitionResult.value;
  if (!definition) {
    logger.info("flow.automated_run_definition_missing", logContext);
    return { status: "settled" };
  }
  if (!definition.enabled && triggerSource.type !== "file-upload") {
    logger.info("flow.automated_run_definition_disabled", logContext);
    return { status: "settled" };
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
      await resolveAuthorization({
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
    return { status: "retry" };
  }
  const authorizedWorkspace = authorization.value?.workspace;
  if (authorizedWorkspace === undefined || authorizedWorkspace === null) {
    logger.warn("flow.automated_run_actor_unauthorized", logContext);
    return { status: "settled" };
  }

  const runId = createSafeId<"flowRun">();
  let outcome: StartAutomatedFlowRunOutcome = { status: "retry" };
  const createAndEnqueue = async (
    signal?: AbortSignal,
    reservePeriod?: () => Promise<void>,
  ) => {
    const rows = buildFlowRunRows({
      runId,
      workspaceId,
      definitionId,
      definition: { name: definition.name, steps: definition.steps },
      triggerSource,
      inputEntityIds,
    });

    signal?.throwIfAborted();
    const insertResult = await Result.tryPromise({
      try: async () =>
        await insertWithinCap({
          definitionId,
          rows,
          ...(reservePeriod && { reservePeriod }),
        }),
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
    if (insertResult.value.outcome === "skipped") {
      outcome = { status: "skipped", reason: insertResult.value.reason };
      logger.info("flow.automated_run_skipped", {
        ...logContext,
        reason: insertResult.value.reason,
      });
      return;
    }
    if (
      insertResult.value.outcome === "already-started" ||
      insertResult.value.outcome === "source-removed"
    ) {
      outcome = { status: "settled" };
      return;
    }
    if (insertResult.value.outcome === "capped") {
      outcome = { status: "retry" };
      logger.info("flow.automated_run_capped", {
        ...logContext,
        dailyRunCount: insertResult.value.dailyRunCount,
      });
      return;
    }

    outcome = { status: "settled" };

    // Enqueue after the rows commit. A failure here leaves the run `pending`; the
    // worker's boot reconciler re-enqueues its current step, so the run is never
    // permanently stranded.
    const enqueued = await Result.tryPromise({
      try: async () =>
        await enqueueStep({
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
  const started = await Result.tryPromise({
    try: async () =>
      await kickoff({
        organizationId,
        userId: brandPersistedUserId(createdByUserId),
        actionKind: QUEUED_ACTION_KIND.flow,
        logicalPhaseId: runId,
        periodReservation: "on-acceptance",
        run: createAndEnqueue,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(started)) {
    observeFailure(started.error, {
      sink: AUTOMATED_RUN_START_FAILURE,
      ctx: { workspaceId, organizationId },
    });
  }
  return outcome;
};
