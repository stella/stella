import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import type { WorkObligationStatus } from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WORK_OBLIGATION_TRANSITION_AUDIT_ACTION } from "@/api/lib/work-obligations/transitions";
import type {
  WorkObligationTransitionAction,
  WorkObligationTransitionResolution,
} from "@/api/lib/work-obligations/transitions";

type SettleWorkObligationOptions = {
  tx: Transaction;
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  actorUserId: SafeId<"user">;
  action: WorkObligationTransitionAction;
  transition: Extract<WorkObligationTransitionResolution, { type: "allowed" }>;
  previousStatus: WorkObligationStatus;
  reason: string | null;
  recordAuditEvent: AuditRecorder;
};

export type SettleWorkObligationResult = "settled" | "conflict";

/**
 * Write a resolved lifecycle move: the obligation's status, the task it
 * governs, the activity event, and the audit change land together in the
 * caller's transaction. The caller has locked the row, resolved the move
 * against it, and applied its own policy (who may act, whether a reason is
 * due); this is the write both the REST transition and a source that settles
 * its own obligation share.
 *
 * The move's `from` statuses are part of the update, so a concurrent move
 * loses: the row matches only while it still holds one of them, and a miss
 * reports a conflict rather than a silent overwrite.
 */
export const settleWorkObligation = async ({
  tx,
  entityId,
  workspaceId,
  actorUserId,
  action,
  transition,
  previousStatus,
  reason,
  recordAuditEvent,
}: SettleWorkObligationOptions): Promise<SettleWorkObligationResult> => {
  const { nextStatus } = transition;
  const now = new Date();
  const acknowledgementReset =
    nextStatus === WORK_OBLIGATION_STATUS.UNASSIGNED
      ? { acknowledgedAt: null, acknowledgedByUserId: null }
      : {};
  const updated = await tx
    .update(workObligations)
    .set({ status: nextStatus, ...acknowledgementReset, updatedAt: now })
    .where(
      and(
        eq(workObligations.entityId, entityId),
        eq(workObligations.workspaceId, workspaceId),
        inArray(workObligations.status, [...transition.from]),
      ),
    )
    .returning({ entityId: workObligations.entityId });
  if (!updated.at(0)) {
    return "conflict";
  }

  await tx
    .update(entities)
    .set({ status: transition.taskStatus, updatedAt: now })
    .where(
      and(
        eq(entities.id, entityId),
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "task"),
      ),
    );

  await tx.insert(workObligationEvents).values({
    id: createSafeId<"workObligationEvent">(),
    workspaceId,
    obligationEntityId: entityId,
    actorUserId,
    type: transition.eventType,
    details: { type: "status_changed", previousStatus, nextStatus },
    reason,
    occurredAt: now,
  });
  await recordAuditEvent(tx, {
    action: WORK_OBLIGATION_TRANSITION_AUDIT_ACTION[action],
    resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
    resourceId: entityId,
    changes: { status: { old: previousStatus, new: nextStatus } },
    ...(reason ? { metadata: { reason } } : {}),
  });

  return "settled";
};
