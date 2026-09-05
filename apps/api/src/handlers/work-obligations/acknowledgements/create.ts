import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";

const acknowledgeParams = workspaceParams({ entityId: tSafeId("entity") });

const acknowledgeWorkObligation = createSafeHandler(
  {
    description:
      "Acknowledge ownership of governed work assigned to the signed-in user.",
    permissions: { entity: ["update"] },
    mcp: { type: "capability", reason: "workflow_orchestration" },
    params: acknowledgeParams,
  },
  async function* ({ safeDb, workspaceId, user, params, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockWorkObligation(tx, {
          entityId: params.entityId,
          workspaceId,
        });
        if (!existing) {
          return { status: "not_found" as const };
        }
        if (existing.ownerUserId !== user.id) {
          return { status: "not_owner" as const };
        }
        if (
          existing.status === WORK_OBLIGATION_STATUS.ACTIVE &&
          existing.acknowledgedByUserId === user.id
        ) {
          return { status: "acknowledged" as const };
        }
        if (
          existing.status !== WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT
        ) {
          return { status: "invalid_status" as const };
        }

        const now = new Date();
        const updated = await tx
          .update(workObligations)
          .set({
            status: WORK_OBLIGATION_STATUS.ACTIVE,
            acknowledgedAt: now,
            acknowledgedByUserId: user.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(workObligations.entityId, params.entityId),
              eq(workObligations.workspaceId, workspaceId),
              eq(
                workObligations.status,
                WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
              ),
              eq(workObligations.ownerUserId, user.id),
            ),
          )
          .returning({ entityId: workObligations.entityId });
        if (!updated.at(0)) {
          return { status: "conflict" as const };
        }

        await tx.insert(workObligationEvents).values({
          id: createSafeId<"workObligationEvent">(),
          workspaceId,
          obligationEntityId: params.entityId,
          actorUserId: user.id,
          type: WORK_OBLIGATION_EVENT_TYPE.ACKNOWLEDGED,
          details: { type: "acknowledged" },
          occurredAt: now,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: params.entityId,
          changes: {
            status: {
              old: existing.status,
              new: WORK_OBLIGATION_STATUS.ACTIVE,
            },
            acknowledgedAt: { old: null, new: now.toISOString() },
          },
        });

        return { status: "acknowledged" as const };
      }),
    );

    switch (result.status) {
      case "acknowledged":
        return Result.ok({ success: true });
      case "not_found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Work obligation not found",
          }),
        );
      case "not_owner":
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Only the accountable owner can acknowledge this work",
          }),
        );
      case "invalid_status":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "This work is not awaiting acknowledgement",
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

export default acknowledgeWorkObligation;
