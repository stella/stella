import { Result } from "better-result";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { FLOW_RUN_TERMINAL_STATUSES } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { flowRuns, flowRunSteps, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
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
  access: "read" | "write";
  userId: SafeId<"user">;
};

/** Shared task entry points and native tools admit linked flow work here. */
export const admitTaskFlowAccess = async (
  tx: Transaction,
  { userId, access, ...task }: AdmitTaskFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  const gate = await reviewGateForTask(tx, task);
  if (gate === undefined) {
    return Result.ok(undefined);
  }
  return await admitLinkedFlowAccess(tx, {
    organizationId: gate.organizationId,
    userId,
    access,
  });
};

type AdmitLinkedFlowAccessOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  access: "read" | "write";
};

const admitLinkedFlowAccess = async (
  tx: Transaction,
  { organizationId, userId, access }: AdmitLinkedFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  if (access === "write") {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
  }
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  const principal = { organizationId, userId };
  const snapshot = await resolveFeatureAccessSnapshot({ tx, ...principal });
  return isFeatureEnabled(snapshot, "flows", principal)
    ? Result.ok(undefined)
    : Result.err(new HandlerError({ status: 404, message: "Not found" }));
};

type AdmitFlowReviewTaskDeletionOptions = {
  workspaceId: SafeId<"workspace">;
  taskEntityIds: SafeId<"entity">[];
  userId: SafeId<"user">;
};

/** Active gates retain their task pointer; terminal history may use the FK's SET NULL. */
export const admitFlowReviewTaskDeletion = async (
  tx: Transaction,
  { workspaceId, taskEntityIds, userId }: AdmitFlowReviewTaskDeletionOptions,
): Promise<Result<void, HandlerError>> => {
  const gates = await tx
    .select({ organizationId: workspaces.organizationId })
    .from(flowRunSteps)
    .innerJoin(workspaces, eq(workspaces.id, flowRunSteps.workspaceId))
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        inArray(flowRunSteps.reviewTaskEntityId, taskEntityIds),
      ),
    )
    .limit(1);
  const gate = gates.at(0);
  if (!gate) {
    return Result.ok(undefined);
  }
  const admission = await admitLinkedFlowAccess(tx, {
    organizationId: gate.organizationId,
    userId,
    access: "write",
  });
  if (admission.isErr()) {
    return admission;
  }
  const active = await tx
    .select({ id: flowRunSteps.id })
    .from(flowRunSteps)
    .innerJoin(
      flowRuns,
      and(
        eq(flowRuns.id, flowRunSteps.runId),
        eq(flowRuns.workspaceId, flowRunSteps.workspaceId),
      ),
    )
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        inArray(flowRunSteps.reviewTaskEntityId, taskEntityIds),
        notInArray(flowRuns.status, FLOW_RUN_TERMINAL_STATUSES),
      ),
    )
    .limit(1);
  return active.length === 0
    ? Result.ok(undefined)
    : Result.err(
        new HandlerError({
          status: 409,
          message: "An active workflow review task cannot be deleted",
        }),
      );
};

export const FLOW_TASK_FEATURE_ACCESS = {
  featureId: "flows",
  type: "conditional",
  decision: "always",
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
    const entityIds = typeof entityId === "string" ? [entityId] : [];
    if (isRecord(body) && Array.isArray(body["entityIds"])) {
      for (const id of body["entityIds"]) {
        if (typeof id === "string") {
          entityIds.push(id);
        }
      }
    }
    if (entityIds.length === 0) {
      return false;
    }
    const gates = await scopedDb((tx) =>
      tx
        .select({ runId: flowRunSteps.runId })
        .from(flowRunSteps)
        .where(
          and(
            eq(flowRunSteps.workspaceId, workspaceId),
            sql`${flowRunSteps.reviewTaskEntityId} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
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
          await admitTaskFlowAccess(tx, {
            workspaceId,
            taskEntityId,
            userId,
            access: "read",
          }),
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
