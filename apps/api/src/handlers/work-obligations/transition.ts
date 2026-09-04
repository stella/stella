import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";
import {
  resolveWorkObligationTransition,
  WORK_OBLIGATION_TRANSITION_ACTION,
  WORK_OBLIGATION_TRANSITION_ACTIONS,
  WORK_OBLIGATION_TRANSITION_AUDIT_ACTION,
} from "@/api/lib/work-obligations/transitions";

const transitionParams = workspaceParams({ entityId: tSafeId("entity") });
const transitionBody = t.Object({
  action: t.UnionEnum(WORK_OBLIGATION_TRANSITION_ACTIONS),
  reason: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});

const transitionWorkObligation = createSafeHandler(
  {
    description:
      "Complete, cancel, or reopen governed work while preserving its lifecycle history.",
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

        const now = new Date();
        const { nextStatus } = transition;
        const acknowledgementReset =
          nextStatus === WORK_OBLIGATION_STATUS.UNASSIGNED
            ? { acknowledgedAt: null, acknowledgedByUserId: null }
            : {};
        const updated = await tx
          .update(workObligations)
          .set({ status: nextStatus, ...acknowledgementReset, updatedAt: now })
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
          reason: reason ?? null,
          occurredAt: now,
        });
        await recordAuditEvent(tx, {
          action: WORK_OBLIGATION_TRANSITION_AUDIT_ACTION[body.action],
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: params.entityId,
          changes: {
            status: { old: existing.status, new: nextStatus },
          },
          ...(reason ? { metadata: { reason } } : {}),
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
        result satisfies never;
        return panic(`Unhandled result: ${String(result)}`);
      }
    }
  },
);

export default transitionWorkObligation;
