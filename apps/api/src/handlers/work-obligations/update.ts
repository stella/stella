import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  entities,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligationEvents,
  workObligations,
  workspaceMembers,
} from "@/api/db/schema";
import type { WorkObligationSource } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { ensureLegacyWorkObligation } from "@/api/lib/work-obligations/legacy-work-obligation";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";

const updateWorkObligationParams = workspaceParams({
  entityId: tSafeId("entity"),
});

const updateWorkObligationBody = t.Object({
  ownerUserId: t.Optional(t.Nullable(tSafeId("user"))),
  type: t.Optional(
    t.Union([
      t.Literal(WORK_OBLIGATION_TYPE.TASK),
      t.Literal(WORK_OBLIGATION_TYPE.DEADLINE),
    ]),
  ),
  workingTargetDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  hardDeadlineDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  sourceType: t.Optional(
    t.Union([
      t.Literal(WORK_OBLIGATION_SOURCE.MANUAL),
      t.Literal(WORK_OBLIGATION_SOURCE.CALENDAR),
      t.Literal(WORK_OBLIGATION_SOURCE.EMAIL),
      t.Literal(WORK_OBLIGATION_SOURCE.DOCUMENT),
      t.Literal(WORK_OBLIGATION_SOURCE.COURT),
      t.Literal(WORK_OBLIGATION_SOURCE.IMPORT),
      t.Literal(WORK_OBLIGATION_SOURCE.API),
    ]),
  ),
  sourceEntityId: t.Optional(t.Nullable(tSafeId("entity"))),
  sourceDescription: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
  reason: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});

type UpdateWorkObligationBody = Static<typeof updateWorkObligationBody>;
type LockedWorkObligation = NonNullable<
  Awaited<ReturnType<typeof lockWorkObligation>>
>;

const changesOwnerOfClosedObligation = (
  body: UpdateWorkObligationBody,
  existing: LockedWorkObligation,
): boolean =>
  body.ownerUserId !== undefined &&
  body.ownerUserId !== existing.ownerUserId &&
  (existing.status === WORK_OBLIGATION_STATUS.COMPLETED ||
    existing.status === WORK_OBLIGATION_STATUS.CANCELLED);

// Self-assignment skips the AWAITING_ACKNOWLEDGEMENT step and goes straight
// to ACTIVE (see the ownerUserId branch below), because the caller is the
// same person who would otherwise acknowledge. That shortcut is fine when
// claiming unowned work, but taking over another member's already-owned
// work the same way would let anyone with entity:update reassign work out
// from under its accountable owner without their consent. Restrict that
// case to admin/owner, same as the other supervisory overrides in this
// codebase (see catalogue/list-catalogue.ts's canDeleteTeamSkills).
const selfAssignsOverAnotherOwner = (
  body: UpdateWorkObligationBody,
  existing: LockedWorkObligation,
  currentUserId: string,
): boolean =>
  body.ownerUserId === currentUserId &&
  existing.ownerUserId !== null &&
  existing.ownerUserId !== currentUserId;

type WorkObligationTransitionViolation =
  | "target_after_deadline"
  | "delegation_reason_required"
  | "deadline_reason_required";

/** Ordered business-policy validation after related entity ownership is known. */
const workObligationTransitionViolation = ({
  body,
  existing,
  reason,
}: {
  body: UpdateWorkObligationBody;
  existing: LockedWorkObligation;
  reason: string | undefined;
}): WorkObligationTransitionViolation | null => {
  const nextWorkingTargetDate =
    body.workingTargetDate === undefined
      ? existing.workingTargetDate
      : body.workingTargetDate;
  const nextHardDeadlineDate =
    body.hardDeadlineDate === undefined
      ? existing.hardDeadlineDate
      : body.hardDeadlineDate;

  if (
    nextWorkingTargetDate !== null &&
    nextHardDeadlineDate !== null &&
    nextWorkingTargetDate > nextHardDeadlineDate
  ) {
    return "target_after_deadline";
  }
  if (
    body.ownerUserId !== undefined &&
    existing.ownerUserId !== null &&
    body.ownerUserId !== existing.ownerUserId &&
    !reason
  ) {
    return "delegation_reason_required";
  }
  if (
    body.hardDeadlineDate !== undefined &&
    existing.hardDeadlineDate !== null &&
    body.hardDeadlineDate !== existing.hardDeadlineDate &&
    !reason
  ) {
    return "deadline_reason_required";
  }
  return null;
};

const updateWorkObligation = createSafeHandler(
  {
    description:
      "Update accountable ownership, dates, type, or provenance for a governed task or deadline.",
    permissions: { entity: ["update"] },
    mcp: { type: "capability", reason: "workflow_orchestration" },
    params: updateWorkObligationParams,
    body: updateWorkObligationBody,
  },
  async function* ({
    safeDb,
    workspaceId,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const reason = body.reason?.trim();
    const hasChange =
      body.ownerUserId !== undefined ||
      body.type !== undefined ||
      body.workingTargetDate !== undefined ||
      body.hardDeadlineDate !== undefined ||
      body.sourceType !== undefined ||
      body.sourceEntityId !== undefined ||
      body.sourceDescription !== undefined;

    if (!hasChange) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "No workflow change provided",
        }),
      );
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockWorkspacesForEntityCap(tx, [workspaceId]);

        // Membership removal locks workspace-member rows before obligations.
        // Lock a requested owner in the same order so removal either observes
        // and clears this delegation, or commits first and makes it invalid.
        if (body.ownerUserId !== undefined && body.ownerUserId !== null) {
          const ownerMembership = await tx
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(workspaceMembers.userId, body.ownerUserId),
              ),
            )
            .limit(1)
            .for("update");
          if (!ownerMembership.at(0)) {
            return { status: "invalid_owner" as const };
          }
        }

        let existing = await lockWorkObligation(tx, {
          entityId: params.entityId,
          workspaceId,
        });
        if (!existing) {
          await ensureLegacyWorkObligation({
            tx,
            entityId: params.entityId,
            workspaceId,
          });
          existing = await lockWorkObligation(tx, {
            entityId: params.entityId,
            workspaceId,
          });
        }
        if (!existing) {
          return { status: "not_found" as const };
        }

        if (changesOwnerOfClosedObligation(body, existing)) {
          return { status: "closed_owner_change" as const };
        }

        if (
          selfAssignsOverAnotherOwner(body, existing, user.id) &&
          memberRole.role !== "admin" &&
          memberRole.role !== "owner"
        ) {
          return { status: "self_assign_forbidden" as const };
        }

        if (
          body.sourceEntityId !== undefined &&
          body.sourceEntityId !== null &&
          body.sourceEntityId !== existing.sourceEntityId
        ) {
          const source = await tx.query.entities.findFirst({
            where: {
              id: { eq: body.sourceEntityId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          });
          if (!source) {
            return { status: "invalid_source" as const };
          }
        }

        const transitionViolation = workObligationTransitionViolation({
          body,
          existing,
          reason,
        });
        if (transitionViolation !== null) {
          return { status: transitionViolation };
        }

        const now = new Date();
        const obligationUpdate: Partial<typeof workObligations.$inferInsert> = {
          updatedAt: now,
        };
        const events: (typeof workObligationEvents.$inferInsert)[] = [];
        const changes: FieldDiffs = {};

        if (
          body.ownerUserId !== undefined &&
          body.ownerUserId !== existing.ownerUserId
        ) {
          const nextOwnerUserId = body.ownerUserId;
          const isSelfAssigned = nextOwnerUserId === user.id;
          obligationUpdate.ownerUserId = nextOwnerUserId;
          obligationUpdate.acknowledgedAt = isSelfAssigned ? now : null;
          obligationUpdate.acknowledgedByUserId = isSelfAssigned
            ? user.id
            : null;
          if (nextOwnerUserId === null) {
            obligationUpdate.status = WORK_OBLIGATION_STATUS.UNASSIGNED;
          } else if (isSelfAssigned) {
            obligationUpdate.status = WORK_OBLIGATION_STATUS.ACTIVE;
          } else {
            obligationUpdate.status =
              WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT;
          }
          changes["ownerUserId"] = {
            old: existing.ownerUserId,
            new: nextOwnerUserId,
          };
          events.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: params.entityId,
            actorUserId: user.id,
            type:
              existing.ownerUserId === null
                ? WORK_OBLIGATION_EVENT_TYPE.OWNER_ASSIGNED
                : WORK_OBLIGATION_EVENT_TYPE.DELEGATED,
            details: {
              type: "ownership_changed",
              previousOwnerUserId: existing.ownerUserId,
              nextOwnerUserId,
            },
            reason: reason ?? null,
            occurredAt: now,
          });
          if (isSelfAssigned) {
            events.push({
              id: createSafeId<"workObligationEvent">(),
              workspaceId,
              obligationEntityId: params.entityId,
              actorUserId: user.id,
              type: WORK_OBLIGATION_EVENT_TYPE.ACKNOWLEDGED,
              details: { type: "acknowledged" },
              occurredAt: now,
            });
          }
        }

        if (body.type !== undefined && body.type !== existing.type) {
          obligationUpdate.type = body.type;
          changes["type"] = { old: existing.type, new: body.type };
          events.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: params.entityId,
            actorUserId: user.id,
            type: WORK_OBLIGATION_EVENT_TYPE.TYPE_CHANGED,
            details: {
              type: "obligation_type_changed",
              previousType: existing.type,
              nextType: body.type,
            },
            reason: reason ?? null,
            occurredAt: now,
          });
        }

        if (
          body.workingTargetDate !== undefined &&
          body.workingTargetDate !== existing.workingTargetDate
        ) {
          obligationUpdate.workingTargetDate = body.workingTargetDate;
          changes["workingTargetDate"] = {
            old: existing.workingTargetDate,
            new: body.workingTargetDate,
          };
          events.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: params.entityId,
            actorUserId: user.id,
            type: WORK_OBLIGATION_EVENT_TYPE.WORKING_TARGET_CHANGED,
            details: {
              type: "date_changed",
              field: "working_target_date",
              previousDate: existing.workingTargetDate,
              nextDate: body.workingTargetDate,
            },
            reason: reason ?? null,
            occurredAt: now,
          });
        }

        if (
          body.hardDeadlineDate !== undefined &&
          body.hardDeadlineDate !== existing.hardDeadlineDate
        ) {
          obligationUpdate.hardDeadlineDate = body.hardDeadlineDate;
          changes["hardDeadlineDate"] = {
            old: existing.hardDeadlineDate,
            new: body.hardDeadlineDate,
          };
          events.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: params.entityId,
            actorUserId: user.id,
            type: WORK_OBLIGATION_EVENT_TYPE.HARD_DEADLINE_CHANGED,
            details: {
              type: "date_changed",
              field: "hard_deadline_date",
              previousDate: existing.hardDeadlineDate,
              nextDate: body.hardDeadlineDate,
            },
            reason: reason ?? null,
            occurredAt: now,
          });
        }

        const nextSourceType: WorkObligationSource =
          body.sourceType ?? existing.sourceType;
        const nextSourceEntityId =
          body.sourceEntityId === undefined
            ? existing.sourceEntityId
            : body.sourceEntityId;
        const provenanceChanged =
          nextSourceType !== existing.sourceType ||
          nextSourceEntityId !== existing.sourceEntityId ||
          (body.sourceDescription !== undefined &&
            body.sourceDescription !== existing.sourceDescription);
        if (provenanceChanged) {
          obligationUpdate.sourceType = nextSourceType;
          obligationUpdate.sourceEntityId = nextSourceEntityId;
          if (body.sourceDescription !== undefined) {
            obligationUpdate.sourceDescription = body.sourceDescription;
          }
          changes["provenance"] = {
            old: {
              sourceType: existing.sourceType,
              sourceEntityId: existing.sourceEntityId,
              sourceDescription: existing.sourceDescription,
            },
            new: {
              sourceType: nextSourceType,
              sourceEntityId: nextSourceEntityId,
              sourceDescription:
                body.sourceDescription === undefined
                  ? existing.sourceDescription
                  : body.sourceDescription,
            },
          };
          events.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: params.entityId,
            actorUserId: user.id,
            type: WORK_OBLIGATION_EVENT_TYPE.PROVENANCE_CHANGED,
            details: {
              type: "provenance_changed",
              previousSourceType: existing.sourceType,
              nextSourceType,
              previousSourceEntityId: existing.sourceEntityId,
              nextSourceEntityId,
            },
            reason: reason ?? null,
            occurredAt: now,
          });
        }

        if (events.length === 0) {
          return { status: "unchanged" as const };
        }

        const updated = await tx
          .update(workObligations)
          .set(obligationUpdate)
          .where(
            and(
              eq(workObligations.entityId, params.entityId),
              eq(workObligations.workspaceId, workspaceId),
              eq(workObligations.status, existing.status),
            ),
          )
          .returning({ entityId: workObligations.entityId });
        if (!updated.at(0)) {
          return { status: "conflict" as const };
        }

        if (body.type !== undefined || body.workingTargetDate !== undefined) {
          const entitySet: Partial<typeof entities.$inferInsert> = {
            updatedAt: now,
          };
          if (body.type !== undefined) {
            entitySet.agendaKind = body.type;
          }
          if (body.workingTargetDate !== undefined) {
            entitySet.dueDate = body.workingTargetDate;
          }
          await tx
            .update(entities)
            .set(entitySet)
            .where(
              and(
                eq(entities.id, params.entityId),
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "task"),
              ),
            );
        }

        await tx.insert(workObligationEvents).values(events);
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: params.entityId,
          changes,
          ...(reason ? { metadata: { reason } } : {}),
        });

        return { status: "updated" as const };
      }),
    );

    switch (result.status) {
      case "updated":
      case "unchanged":
        return Result.ok({ success: true });
      case "not_found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Work obligation not found",
          }),
        );
      case "invalid_owner":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Owner must be a workspace member",
          }),
        );
      case "invalid_source":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Source must belong to this workspace",
          }),
        );
      case "closed_owner_change":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Reopen the work before changing its owner",
          }),
        );
      case "self_assign_forbidden":
        return Result.err(
          new HandlerError({
            status: 403,
            message:
              "Only an admin or owner can reassign work already owned by someone else",
          }),
        );
      case "target_after_deadline":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Working target cannot be after the hard deadline",
          }),
        );
      case "delegation_reason_required":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "A reason is required when delegating work",
          }),
        );
      case "deadline_reason_required":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "A reason is required when revising a hard deadline",
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

export default updateWorkObligation;
