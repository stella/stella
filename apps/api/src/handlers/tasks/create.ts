import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  entityVersions,
  taskAssignees,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  AGENDA_ITEM_KIND,
  AGENDA_ITEM_KINDS,
  ENTITY_PRIORITIES,
  TASK_STATUSES,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";
import { includes } from "@/api/lib/type-guards";

import { validateAgendaFields } from "./agenda-fields";

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

const createTaskBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  parentId: t.Optional(tSafeId("entity")),
  agendaKind: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  priority: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
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
    t.Array(t.String(), {
      maxItems: LIMITS.workspaceMembersCount,
    }),
  ),
});

const toDateOrNull = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

const createTask = createSafeHandler(
  {
    permissions: { entity: ["create"] },
    body: createTaskBodySchema,
  },
  async function* ({ workspaceId, user, body, safeDb }) {
    const agendaKind = body.agendaKind ?? AGENDA_ITEM_KIND.TASK;
    const taskStatus = body.status ?? "open";
    const taskPriority = body.priority ?? "none";

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
    const agendaFields = validateAgendaFields({
      attendees: body.attendees,
      availability: body.availability,
      sensitivity: body.sensitivity,
    });
    if (agendaFields.status === "error") {
      return Result.err(agendaFields.error);
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
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

        const entityId = createSafeId<"entity">();
        await tx.insert(entities).values({
          id: entityId,
          workspaceId,
          kind: "task",
          parentId: body.parentId ?? null,
          name: body.name,
          createdBy: user.id,
          agendaKind,
          status: taskStatus,
          priority: taskPriority,
          dueDate: body.dueDate ?? null,
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

        if (body.assigneeIds !== undefined && body.assigneeIds.length > 0) {
          const members = await tx.query.workspaceMembers.findMany({
            where: {
              workspaceId: { eq: workspaceId },
              userId: { in: body.assigneeIds },
            },
            columns: { userId: true },
          });
          const memberIds = new Set(members.map((m) => m.userId));
          const invalidIds = body.assigneeIds.filter(
            (uid) => !memberIds.has(uid),
          );
          if (invalidIds.length > 0) {
            return {
              ok: false as const,
              status: 400 as const,
              message: "Some assignee IDs are not workspace members",
            };
          }
          const validIds = [...new Set(body.assigneeIds)];

          if (validIds.length > 0) {
            await tx.insert(taskAssignees).values(
              validIds.map((uid) => ({
                entityId,
                workspaceId,
                userId: uid,
                role: "assignee" as const,
              })),
            );
          }
        }

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

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

    getSearchProvider().indexEntity(txResult.entityId).catch(captureError);

    return Result.ok({ entityId: txResult.entityId });
  },
);

export const createTaskHandler = createTask.handler;

export default createTask;
