import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalListItems,
  LIST_ITEM_TYPES,
  taskAssignees,
  workspaceMembers,
  type WorkObligationSource,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  AGENDA_ITEM_KIND,
  AGENDA_ITEM_KINDS,
  ENTITY_PRIORITIES,
  TASK_STATUSES,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import { validateAgendaFields } from "@/api/lib/tasks/agenda-fields";
import {
  deployedTaskFeatures,
  type TaskDeploymentFeatures,
} from "@/api/lib/tasks/deployment-features";
import { includes } from "@/api/lib/type-guards";
import { createWorkObligation } from "@/api/lib/work-obligations/create-work-obligation";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";

const agendaDateTimeSchema = t.Nullable(t.String({ format: "date-time" }));
const agendaParticipantSchema = t.Object({
  email: t.Nullable(t.String({ format: "email", maxLength: 320 })),
  name: t.Nullable(t.String({ maxLength: 512 })),
});
const agendaAttendeeSchema = t.Object({
  email: t.Nullable(t.String({ format: "email", maxLength: 320 })),
  name: t.Nullable(t.String({ maxLength: 512 })),
  optional: t.Optional(t.Boolean()),
  responseStatus: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  type: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
});
const agendaRecurrenceSchema = t.Object({
  pattern: t.Nullable(t.String({ maxLength: 2000 })),
  range: t.Nullable(t.String({ maxLength: 2000 })),
});

export const createTaskBodySchema = t.Object({
  name: t.String({
    minLength: 1,
    maxLength: 255,
    description: "Task name; required when creating",
  }),
  parentId: t.Optional(tSafeId("entity")),
  agendaKind: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  status: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "Task status (e.g. open, in_progress, done)",
    }),
  ),
  priority: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 16,
      description: "Task priority (e.g. none, low, medium, high)",
    }),
  ),
  dueDate: t.Optional(
    t.Nullable(
      t.String({
        format: "date",
        description: "Due date (ISO YYYY-MM-DD); pass null to clear",
      }),
    ),
  ),
  listItemType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  listId: t.Optional(tSafeId("legalList")),
  listSectionId: t.Optional(tSafeId("legalListSection")),
  listPosition: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  listDescription: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  startAt: t.Optional(agendaDateTimeSchema),
  endAt: t.Optional(agendaDateTimeSchema),
  occurredAt: t.Optional(agendaDateTimeSchema),
  remindAt: t.Optional(agendaDateTimeSchema),
  allDay: t.Optional(t.Boolean()),
  timeZone: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  location: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
  onlineMeetingUrl: t.Optional(t.Nullable(t.String({ maxLength: 2048 }))),
  availability: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  sensitivity: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  organizer: t.Optional(t.Nullable(agendaParticipantSchema)),
  attendees: t.Optional(
    t.Nullable(
      t.Array(agendaAttendeeSchema, {
        maxItems: LIMITS.agendaAttendeesMax,
      }),
    ),
  ),
  recurrence: t.Optional(t.Nullable(agendaRecurrenceSchema)),
  assigneeIds: t.Optional(
    t.Array(tSafeId("user"), {
      maxItems: LIMITS.workspaceMembersCount,
    }),
  ),
  ownerUserId: t.Optional(tSafeId("user")),
  workingTargetDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  hardDeadlineDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  sourceDescription: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
});

const toDateOrNull = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

type CreateTaskWorkObligationSource = {
  type: WorkObligationSource;
  description: string | null;
  entityId?: SafeId<"entity">;
};

export type CreateTaskEntityHandlerProps = SafeDbOrTx & {
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof createTaskBodySchema>;
  entityId?: SafeId<"entity">;
  features?: TaskDeploymentFeatures;
  workObligationSource?: CreateTaskWorkObligationSource;
};

export const createTaskEntityHandler = async function* ({
  ...props
}: CreateTaskEntityHandlerProps) {
  const {
    workspaceId,
    userId,
    recordAuditEvent,
    body,
    entityId: requestedEntityId,
    features = deployedTaskFeatures(),
    workObligationSource,
  } = props;
  const agendaKind = body.agendaKind ?? AGENDA_ITEM_KIND.TASK;
  const taskStatus = body.status ?? "open";
  const taskPriority = body.priority ?? "none";
  const workingTargetDate = body.workingTargetDate ?? body.dueDate ?? null;
  const hardDeadlineDate =
    body.hardDeadlineDate ??
    (agendaKind === AGENDA_ITEM_KIND.DEADLINE ? (body.dueDate ?? null) : null);
  const listItemType = body.listItemType ?? "task";

  if (
    !features.governedWorkflow &&
    (body.ownerUserId !== undefined ||
      body.workingTargetDate !== undefined ||
      body.hardDeadlineDate !== undefined ||
      body.sourceDescription !== undefined)
  ) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Governed Workflow is disabled",
      }),
    );
  }

  if (
    !features.legalLists &&
    (listItemType !== "task" ||
      body.listId !== undefined ||
      body.listSectionId !== undefined ||
      body.listPosition !== undefined ||
      body.listDescription !== undefined)
  ) {
    return Result.err(
      new HandlerError({ status: 404, message: "Legal Lists are disabled" }),
    );
  }

  if (!includes(AGENDA_ITEM_KINDS, agendaKind)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid agenda item kind" }),
    );
  }
  if (!includes(TASK_STATUSES, taskStatus)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid task status" }),
    );
  }
  if (!includes(ENTITY_PRIORITIES, taskPriority)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid task priority" }),
    );
  }
  if (
    workingTargetDate !== null &&
    hardDeadlineDate !== null &&
    workingTargetDate > hardDeadlineDate
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Working target cannot be after the hard deadline",
      }),
    );
  }
  if (!includes(LIST_ITEM_TYPES, listItemType)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid list item type" }),
    );
  }
  const governsWork =
    features.governedWorkflow && isWorkObligationEligible(listItemType);
  if (
    !isWorkObligationEligible(listItemType) &&
    (body.ownerUserId !== undefined ||
      body.workingTargetDate !== undefined ||
      body.hardDeadlineDate !== undefined ||
      body.sourceDescription !== undefined)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `A ${listItemType} row cannot carry governed work`,
      }),
    );
  }
  if (body.listSectionId !== undefined && body.listId === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "A List section requires a List",
      }),
    );
  }
  const agendaFields = validateAgendaFields({
    attendees: body.attendees,
    availability: body.availability,
    sensitivity: body.sensitivity,
  });
  if (agendaFields.status === "error") {
    return Result.err(agendaFields.error);
  }

  const txResult = yield* Result.await(
    withScopedTx(props, async (tx) => {
      // See `lockWorkspacesForEntityCap` for the canonical lock
      // order every entity-creating path follows (issue #1139).
      await lockWorkspacesForEntityCap(tx, [workspaceId]);

      const totalEntities = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );
      if (totalEntities >= LIMITS.entitiesCount) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Entities limit reached",
        };
      }

      if (body.parentId) {
        const parent = await tx.query.entities.findFirst({
          where: {
            id: { eq: body.parentId },
            workspaceId: { eq: workspaceId },
          },
          columns: { kind: true },
        });
        if (!parent) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Parent entity not found in this workspace",
          };
        }
        if (parent.kind !== "task") {
          return {
            ok: false as const,
            status: 400 as const,
            message: `Subtasks must belong to a task, not a ${parent.kind}`,
          };
        }
      }

      const requestedAssigneeIds =
        body.assigneeIds === undefined ? [] : [...new Set(body.assigneeIds)];
      const memberIdsToValidate = body.ownerUserId ? [body.ownerUserId] : [];
      memberIdsToValidate.push(...requestedAssigneeIds);
      const memberIdsToLoad = [...memberIdsToValidate];
      if (!memberIdsToLoad.includes(userId)) {
        memberIdsToLoad.push(userId);
      }
      const members = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            inArray(workspaceMembers.userId, memberIdsToLoad),
          ),
        )
        .limit(LIMITS.workspaceMembersCount)
        .for("update");
      const workspaceMemberIds = new Set(
        members.map((member) => brandPersistedUserId(member.userId)),
      );
      if (memberIdsToValidate.some((id) => !workspaceMemberIds.has(id))) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "The owner and assignees must be workspace members",
        };
      }
      const validAssigneeIds =
        body.assigneeIds === undefined &&
        !features.governedWorkflow &&
        workspaceMemberIds.has(userId)
          ? [userId]
          : requestedAssigneeIds;
      const ownerUserId =
        body.ownerUserId ?? (workspaceMemberIds.has(userId) ? userId : null);

      if (body.listId) {
        const list = await tx.query.legalLists.findFirst({
          where: {
            id: { eq: body.listId },
            workspaceId: { eq: workspaceId },
            status: { eq: "active" },
          },
          columns: { id: true },
        });
        if (!list) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Active List not found in this workspace",
          };
        }
      }

      if (body.listSectionId && body.listId) {
        const section = await tx.query.legalListSections.findFirst({
          where: {
            id: { eq: body.listSectionId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        });
        if (!section) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "List section not found in this List",
          };
        }
      }

      const entityId = requestedEntityId ?? createSafeId<"entity">();
      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        kind: "task",
        listItemType,
        parentId: body.parentId ?? null,
        name: body.name,
        createdBy: userId,
        agendaKind,
        status: taskStatus,
        priority: taskPriority,
        dueDate: workingTargetDate,
        startAt: toDateOrNull(body.startAt),
        endAt: toDateOrNull(body.endAt),
        occurredAt: toDateOrNull(body.occurredAt),
        remindAt: toDateOrNull(body.remindAt),
        allDay: body.allDay ?? false,
        timeZone: body.timeZone ?? null,
        location: body.location ?? null,
        onlineMeetingUrl: body.onlineMeetingUrl ?? null,
        availability: agendaFields.availability ?? null,
        sensitivity: agendaFields.sensitivity ?? null,
        organizer: body.organizer ?? null,
        attendees: agendaFields.attendees ?? null,
        recurrence: body.recurrence ?? null,
        agendaSource: "manual",
      });

      const entityVersionId = createSafeId<"entityVersion">();
      await tx.insert(entityVersions).values({
        id: entityVersionId,
        workspaceId,
        entityId,
        versionNumber: 1,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      if (body.listId) {
        await tx.insert(legalListItems).values({
          entityId,
          workspaceId,
          listId: body.listId,
          sectionId: body.listSectionId ?? null,
          position: body.listPosition ?? entityId,
          description: body.listDescription ?? null,
          addedBy: userId,
        });
      }

      if (validAssigneeIds.length > 0) {
        await tx.insert(taskAssignees).values(
          validAssigneeIds.map((assigneeId) => ({
            entityId,
            workspaceId,
            userId: assigneeId,
            role: "assignee" as const,
          })),
        );
      }

      if (governsWork) {
        await createWorkObligation({
          tx,
          entityId,
          workspaceId,
          actorUserId: userId,
          ownerUserId,
          agendaKind,
          taskStatus,
          workingTargetDate,
          hardDeadlineDate,
          ...(workObligationSource === undefined &&
          body.sourceDescription !== undefined
            ? { sourceDescription: body.sourceDescription }
            : {}),
          ...(workObligationSource
            ? {
                sourceType: workObligationSource.type,
                sourceDescription: workObligationSource.description,
              }
            : {}),
          ...(workObligationSource?.entityId
            ? { sourceEntityId: workObligationSource.entityId }
            : {}),
        });
      }

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await recordAuditEvent(tx, [
        {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entityId,
          metadata: {
            kind: "task",
            listItemType,
            agendaKind,
            ...(body.listId && { listId: body.listId }),
            ...(body.parentId && { parentId: body.parentId }),
          },
        },
        ...(governsWork
          ? [
              {
                action: AUDIT_ACTION.CREATE,
                resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
                resourceId: entityId,
                metadata: { ownerUserId },
              } as const,
            ]
          : []),
      ]);

      await enqueueEntitySearchRepairs(tx, [entityId]);

      return { ok: true as const, entityId };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({
        status: txResult.status,
        message: txResult.message,
      }),
    );
  }

  // A caller-provided transaction has not committed yet. Its owner flushes
  // after commit so the repair worker cannot race an invisible entity.
  if (props.tx === undefined) {
    flushEntitySearchRepairs([txResult.entityId]).catch(captureError);
  }

  return Result.ok({ entityId: txResult.entityId });
};
