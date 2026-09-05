import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { flowRunSteps, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";
import type { FlowRunActionResult } from "@/api/lib/flows/flow-executor";
import type { FlowReviewDecision } from "@/api/lib/flows/flow-types";
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

export const gateDecisionForTransition = (
  action: WorkObligationTransitionAction,
): FlowReviewDecision | null => GATE_DECISION_BY_ACTION[action];

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
  /** The resolver's own injection points, passed through for tests. */
  dependencies: Parameters<typeof resolveFlowReviewGate>[1] = {},
): Promise<Result<FlowRunActionResult, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const gates = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            runId: flowRunSteps.runId,
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
          .limit(1),
      ),
    );
    const gate = gates.at(0);
    if (gate === undefined) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The workflow run this task reviewed no longer exists",
        }),
      );
    }
    const resolved = yield* Result.await(
      resolveFlowReviewGate(
        {
          safeDb,
          workspaceId,
          organizationId: gate.organizationId,
          runId: gate.runId,
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
