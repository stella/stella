import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decideGateForTask,
  gateDecisionForTransition,
} from "@/api/lib/flows/review-gate-task";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";
import { settleWorkObligation } from "@/api/lib/work-obligations/settle-work-obligation";
import {
  resolveWorkObligationTransition,
  WORK_OBLIGATION_TRANSITION_ACTION,
  WORK_OBLIGATION_TRANSITION_ACTIONS,
} from "@/api/lib/work-obligations/transitions";

const transitionParams = workspaceParams({ entityId: tSafeId("entity") });
const transitionBody = t.Object({
  action: t.UnionEnum(WORK_OBLIGATION_TRANSITION_ACTIONS),
  reason: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});

const transitionWorkObligation = createSafeHandler(
  {
    description:
      "Complete, cancel, or reopen governed work while preserving its lifecycle history. Completing or cancelling the task a workflow review gate raised approves or rejects that gate.",
    permissions: { entity: ["update"] },
    mcp: { type: "capability", reason: "workflow_orchestration" },
    params: transitionParams,
    body: transitionBody,
  },
  async function* ({
    safeDb,
    workspaceId,
    user,
    params,
    body,
    recordAuditEvent,
  }) {
    const reason = body.reason?.trim();
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockWorkObligation(tx, {
          entityId: params.entityId,
          workspaceId,
        });
        if (!existing) {
          return { status: "not_found" as const };
        }
        if (existing.sourceType === WORK_OBLIGATION_SOURCE.FLOW) {
          return { status: "flow_review" as const };
        }
        const transition = resolveWorkObligationTransition(
          body.action,
          existing,
        );
        if (transition.type === "invalid_status") {
          return { status: "invalid_status" as const };
        }
        if (
          body.action === WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE &&
          existing.ownerUserId !== user.id
        ) {
          return { status: "not_owner" as const };
        }
        if (
          body.action === WORK_OBLIGATION_TRANSITION_ACTION.CANCEL &&
          existing.status !== WORK_OBLIGATION_STATUS.UNASSIGNED &&
          !reason
        ) {
          return { status: "reason_required" as const };
        }

        const settled = await settleWorkObligation({
          tx,
          entityId: params.entityId,
          workspaceId,
          actorUserId: user.id,
          action: body.action,
          transition,
          previousStatus: existing.status,
          reason: reason ?? null,
          recordAuditEvent,
        });
        return settled === "settled"
          ? { status: "transitioned" as const }
          : { status: "conflict" as const };
      }),
    );

    switch (result.status) {
      case "transitioned":
        return Result.ok({ success: true });
      case "flow_review":
        break;
      case "not_found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Work obligation not found",
          }),
        );
      case "invalid_status":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Work cannot make that transition from its current status",
          }),
        );
      case "not_owner":
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Only the accountable owner can complete this work",
          }),
        );
      case "reason_required":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "A reason is required when cancelling assigned work",
          }),
        );
      case "conflict":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Work changed concurrently; refresh and try again",
          }),
        );
      default: {
        result satisfies never;
        return panic(`Unhandled result: ${String(result)}`);
      }
    }

    // The task belongs to a workflow review gate: the decision is the gate's,
    // and the run settles the task itself once it is recorded.
    const decision = gateDecisionForTransition(body.action);
    if (decision === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "A workflow review cannot be reopened; start the workflow again instead",
        }),
      );
    }
    yield* Result.await(
      decideGateForTask({
        safeDb,
        workspaceId,
        taskEntityId: params.entityId,
        userId: user.id,
        decision,
        note: reason ?? null,
        recordAuditEvent,
      }),
    );
    return Result.ok({ success: true });
  },
);

export default transitionWorkObligation;
