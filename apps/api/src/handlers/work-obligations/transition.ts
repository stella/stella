import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { roles } from "@stll/permissions";

import {
  flowRunSteps,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";
import type { FlowReviewDecision } from "@/api/lib/flows/flow-types";
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
  (typeof WORK_OBLIGATION_TRANSITION_ACTIONS)[number],
  FlowReviewDecision | null
>;

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
    session,
    memberRole,
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
    const decision = GATE_DECISION_BY_ACTION[body.action];
    if (decision === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "A workflow review cannot be reopened; start the workflow again instead",
        }),
      );
    }
    if (!roles[memberRole.role].authorize({ flow: ["review"] }).success) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Reviewing a workflow run requires the review permission",
        }),
      );
    }
    const gateSteps = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ runId: flowRunSteps.runId })
          .from(flowRunSteps)
          .where(
            and(
              eq(flowRunSteps.workspaceId, workspaceId),
              eq(flowRunSteps.reviewTaskEntityId, params.entityId),
            ),
          )
          .limit(1),
      ),
    );
    const runId = gateSteps.at(0)?.runId;
    if (runId === undefined) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The workflow run this task reviewed no longer exists",
        }),
      );
    }
    const resolved = yield* Result.await(
      resolveFlowReviewGate({
        safeDb,
        workspaceId,
        organizationId: session.activeOrganizationId,
        runId,
        userId: user.id,
        decision,
        note: reason ?? null,
        recordAuditEvent,
      }),
    );
    yield* Result.await(
      safeDb(
        async (tx) =>
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.REVIEW,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: resolved.runId,
            changes: { review: { old: null, new: { decision } } },
          }),
      ),
    );
    return Result.ok({ success: true });
  },
);

export default transitionWorkObligation;
