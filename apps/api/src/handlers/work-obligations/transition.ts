import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import type { WorkObligationStatus } from "@/api/db/schema";
import { lockWorkObligation } from "@/api/handlers/work-obligations/lock-work-obligation";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const TRANSITION_ACTION = {
  COMPLETE: "complete",
  CANCEL: "cancel",
  REOPEN: "reopen",
} as const;

type TransitionAction =
  (typeof TRANSITION_ACTION)[keyof typeof TRANSITION_ACTION];

const transitionParams = workspaceParams({ entityId: tSafeId("entity") });
const transitionBody = t.Object({
  action: t.UnionEnum([
    TRANSITION_ACTION.COMPLETE,
    TRANSITION_ACTION.CANCEL,
    TRANSITION_ACTION.REOPEN,
  ]),
  reason: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});

type TransitionDefinition = {
  from: readonly WorkObligationStatus[];
  to: WorkObligationStatus;
  eventType: "completed" | "cancelled" | "reopened";
  taskStatus: "done" | "cancelled" | "in_progress";
};

const TRANSITIONS = {
  complete: {
    from: [WORK_OBLIGATION_STATUS.ACTIVE],
    to: WORK_OBLIGATION_STATUS.COMPLETED,
    eventType: WORK_OBLIGATION_EVENT_TYPE.COMPLETED,
    taskStatus: TASK_STATUS.DONE,
  },
  cancel: {
    from: [
      WORK_OBLIGATION_STATUS.UNASSIGNED,
      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
      WORK_OBLIGATION_STATUS.ACTIVE,
    ],
    to: WORK_OBLIGATION_STATUS.CANCELLED,
    eventType: WORK_OBLIGATION_EVENT_TYPE.CANCELLED,
    taskStatus: TASK_STATUS.CANCELLED,
  },
  reopen: {
    from: [WORK_OBLIGATION_STATUS.COMPLETED, WORK_OBLIGATION_STATUS.CANCELLED],
    to: WORK_OBLIGATION_STATUS.ACTIVE,
    eventType: WORK_OBLIGATION_EVENT_TYPE.REOPENED,
    taskStatus: TASK_STATUS.IN_PROGRESS,
  },
} as const satisfies Record<TransitionAction, TransitionDefinition>;

const transitionWorkObligation = createSafeHandler(
  {
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
    const transition = TRANSITIONS[body.action];
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockWorkObligation(tx, {
          entityId: params.entityId,
          workspaceId,
        });
        if (!existing) {
          return { status: "not_found" as const };
        }
        if (!transition.from.some((status) => status === existing.status)) {
          return { status: "invalid_status" as const };
        }
        if (
          body.action === TRANSITION_ACTION.COMPLETE &&
          existing.ownerUserId !== user.id
        ) {
          return { status: "not_owner" as const };
        }
        if (
          body.action === TRANSITION_ACTION.CANCEL &&
          existing.status !== WORK_OBLIGATION_STATUS.UNASSIGNED &&
          !body.reason
        ) {
          return { status: "reason_required" as const };
        }

        const now = new Date();
        const reopenedStatus =
          existing.ownerUserId === null
            ? WORK_OBLIGATION_STATUS.UNASSIGNED
            : existing.acknowledgedAt === null
              ? WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT
              : WORK_OBLIGATION_STATUS.ACTIVE;
        const nextStatus =
          body.action === TRANSITION_ACTION.REOPEN
            ? reopenedStatus
            : transition.to;
        const updated = await tx
          .update(workObligations)
          .set({ status: nextStatus, updatedAt: now })
          .where(
            and(
              eq(workObligations.entityId, params.entityId),
              eq(workObligations.workspaceId, workspaceId),
              inArray(workObligations.status, [...transition.from]),
            ),
          )
          .returning({ entityId: workObligations.entityId });
        if (!updated.at(0)) {
          return { status: "conflict" as const };
        }

        await tx
          .update(entities)
          .set({ status: transition.taskStatus, updatedAt: now })
          .where(
            and(
              eq(entities.id, params.entityId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
            ),
          );

        await tx.insert(workObligationEvents).values({
          id: createSafeId<"workObligationEvent">(),
          workspaceId,
          obligationEntityId: params.entityId,
          actorUserId: user.id,
          type: transition.eventType,
          details: {
            type: "status_changed",
            previousStatus: existing.status,
            nextStatus,
          },
          reason: body.reason ?? null,
          occurredAt: now,
        });
        await recordAuditEvent(tx, {
          action:
            body.action === TRANSITION_ACTION.CANCEL
              ? AUDIT_ACTION.CANCEL
              : AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: params.entityId,
          changes: {
            status: { old: existing.status, new: nextStatus },
          },
          metadata: body.reason ? { reason: body.reason } : undefined,
        });

        return { status: "transitioned" as const };
      }),
    );

    switch (result.status) {
      case "transitioned":
        return Result.ok({ success: true });
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
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  },
);

export default transitionWorkObligation;
