import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { flowRunSteps, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";
import type { FlowRunActionResult } from "@/api/lib/flows/flow-executor";
import type { FlowReviewDecision } from "@/api/lib/flows/flow-types";
import { isRecord } from "@/api/lib/type-guards";
import { WORK_OBLIGATION_TRANSITION_ACTION } from "@/api/lib/work-obligations/transitions";
import type { WorkObligationTransitionAction } from "@/api/lib/work-obligations/transitions";

/**
 * Completing the task a review gate raised approves the gate and cancelling
 * it rejects the gate; the run then settles the task itself, so the decision
 * is recorded once. A gate cannot be reopened: its run has moved on.
 */
const GATE_DECISION_BY_ACTION = {
  complete: "approved",
  cancel: "rejected",
  reopen: null,
} as const satisfies Record<
  WorkObligationTransitionAction,
  FlowReviewDecision | null
>;

export const gateDecisionForTransition = <
  TAction extends WorkObligationTransitionAction,
>(
  action: TAction,
) => GATE_DECISION_BY_ACTION[action];

type ReviewGateForTaskOptions = {
  workspaceId: SafeId<"workspace">;
  taskEntityId: SafeId<"entity">;
};

/** Ownership survives task metadata changes and governed-workflow toggles. */
export const reviewGateForTask = async (
  tx: Transaction,
  { workspaceId, taskEntityId }: ReviewGateForTaskOptions,
) => {
  const gates = await tx
    .select({
      runId: flowRunSteps.runId,
      status: flowRunSteps.status,
      organizationId: workspaces.organizationId,
    })
    .from(flowRunSteps)
    .innerJoin(workspaces, eq(workspaces.id, flowRunSteps.workspaceId))
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        eq(flowRunSteps.reviewTaskEntityId, taskEntityId),
      ),
    )
    .limit(1);
  return gates.at(0);
};

type AdmitTaskFlowAccessOptions = ReviewGateForTaskOptions & {
  userId: SafeId<"user">;
};

/** Shared task entry points and native tools admit linked flow work here. */
export const admitTaskFlowAccess = async (
  tx: Transaction,
  { userId, ...task }: AdmitTaskFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  const gate = await reviewGateForTask(tx, task);
  if (gate === undefined) {
    return Result.ok(undefined);
  }
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  const principal = { organizationId: gate.organizationId, userId };
  const snapshot = await resolveFeatureAccessSnapshot({ tx, ...principal });
  return isFeatureEnabled(snapshot, "flows", principal)
    ? Result.ok(undefined)
    : Result.err(new HandlerError({ status: 404, message: "Not found" }));
};

export const FLOW_TASK_FEATURE_ACCESS = {
  featureId: "flows",
  type: "conditional",
  usesFeature: async (context) => {
    const { body, params, workspaceId, scopedDb } = context;
    if (workspaceId === undefined) {
      return false;
    }
    const taskId = isRecord(params)
      ? (params["taskId"] ?? params["entityId"])
      : undefined;
    const entityId =
      taskId ??
      (isRecord(body) ? (body["taskId"] ?? body["entityId"]) : undefined);
    if (typeof entityId !== "string") {
      return false;
    }
    const gates = await scopedDb((tx) =>
      tx
        .select({ runId: flowRunSteps.runId })
        .from(flowRunSteps)
        .where(
          and(
            eq(flowRunSteps.workspaceId, workspaceId),
            eq(flowRunSteps.reviewTaskEntityId, sql`${entityId}`),
          ),
        )
        .limit(1),
    );
    return gates.length !== 0;
  },
  // The feature is selected by the persisted task link, not an input option.
  projectInputSchema: (schemas) => schemas,
} as const satisfies FeatureAccessRequirement;

type GateDecisionForTaskStatusOptions = ReviewGateForTaskOptions & {
  requestedStatus: string | undefined;
};

/** Closing the linked task decides its gate even without an obligation. */
export const gateDecisionForTaskStatus = async (
  tx: Transaction,
  { requestedStatus, ...task }: GateDecisionForTaskStatusOptions,
): Promise<Result<FlowReviewDecision | null, HandlerError>> => {
  if (requestedStatus === undefined) {
    return Result.ok(null);
  }
  const gate = await reviewGateForTask(tx, task);
  if (!gate) {
    return Result.ok(null);
  }
  if (gate.status !== "awaiting_review") {
    const currentTask = await tx.query.entities.findFirst({
      where: {
        id: { eq: task.taskEntityId },
        workspaceId: { eq: task.workspaceId },
      },
      columns: { status: true },
    });
    if (currentTask?.status === requestedStatus) {
      return Result.ok(null);
    }
  }
  if (requestedStatus === TASK_STATUS.CANCELLED) {
    return Result.ok(
      gateDecisionForTransition(WORK_OBLIGATION_TRANSITION_ACTION.CANCEL),
    );
  }
  if (requestedStatus === TASK_STATUS.DONE) {
    return Result.ok(
      gateDecisionForTransition(WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE),
    );
  }
  if (gate.status !== "awaiting_review") {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "A workflow review cannot be reopened; start the workflow again instead",
      }),
    );
  }
  return Result.ok(null);
};

type DecideGateForTaskOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  taskEntityId: SafeId<"entity">;
  userId: SafeId<"user">;
  decision: FlowReviewDecision;
  note: string | null;
  recordAuditEvent: AuditRecorder;
};

/**
 * Decide the review gate that raised a task. Every path that closes such a
 * task (the obligation transition, a task status change, the `save_task`
 * capability) lands here, so the gate is decided once and the run settles
 * the task itself; a caller that closed the task on its own would leave the
 * run waiting forever.
 */
export const decideGateForTask = async (
  {
    safeDb,
    workspaceId,
    taskEntityId,
    userId,
    decision,
    note,
    recordAuditEvent,
  }: DecideGateForTaskOptions,
  /** The resolver's side effects, including notices deferred until commit. */
  dependencies: Parameters<typeof resolveFlowReviewGate>[1] = {},
): Promise<Result<FlowRunActionResult, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const gate = yield* Result.await(
      safeDb(
        async (tx) =>
          await reviewGateForTask(tx, { workspaceId, taskEntityId }),
      ),
    );
    if (gate === undefined) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The workflow run this task reviewed no longer exists",
        }),
      );
    }
    const admission = yield* Result.await(
      safeDb(
        async (tx) =>
          await admitTaskFlowAccess(tx, { workspaceId, taskEntityId, userId }),
      ),
    );
    yield* admission;
    const resolved = yield* Result.await(
      resolveFlowReviewGate(
        {
          safeDb,
          workspaceId,
          organizationId: gate.organizationId,
          runId: gate.runId,
          reviewTaskEntityId: taskEntityId,
          userId,
          decision,
          note,
          recordAuditEvent,
        },
        dependencies,
      ),
    );
    return Result.ok(resolved);
  });
