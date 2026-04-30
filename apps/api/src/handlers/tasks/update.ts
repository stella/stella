import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import type { AgendaItemKind } from "@/api/lib/entity-constants";
import {
  AGENDA_ITEM_KINDS,
  ENTITY_PRIORITIES,
  TASK_STATUSES,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
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

const updateTaskBodySchema = t.Object({
  taskId: tSafeId("entity"),
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
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
  sortOrder: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
});

const toDateOrNull = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

type AgendaKindValidationResult =
  | { agendaKind: AgendaItemKind | undefined; status: "ok" }
  | { error: HandlerError; status: "error" };

const validateAgendaKind = (
  value: string | undefined,
): AgendaKindValidationResult => {
  if (value === undefined) {
    return { agendaKind: undefined, status: "ok" };
  }
  if (includes(AGENDA_ITEM_KINDS, value)) {
    return { agendaKind: value, status: "ok" };
  }
  return {
    error: new HandlerError({
      status: 400,
      message: "Invalid agenda item kind",
    }),
    status: "error",
  };
};

const updateTask = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    body: updateTaskBodySchema,
  },
  async function* ({ workspaceId, body, safeDb }) {
    const agendaKindResult = validateAgendaKind(body.agendaKind);
    if (agendaKindResult.status === "error") {
      return Result.err(agendaKindResult.error);
    }
    const { agendaKind } = agendaKindResult;
    if (body.status !== undefined && !includes(TASK_STATUSES, body.status)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid task status" }),
      );
    }
    if (
      body.priority !== undefined &&
      !includes(ENTITY_PRIORITIES, body.priority)
    ) {
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

    const updated = yield* Result.await(
      safeDb((tx) =>
        tx
          .update(entities)
          .set({
            ...(body.name !== undefined && { name: body.name }),
            ...(agendaKind !== undefined && {
              agendaKind,
            }),
            ...(body.status !== undefined && {
              status: body.status,
            }),
            ...(body.priority !== undefined && {
              priority: body.priority,
            }),
            ...(body.dueDate !== undefined && {
              dueDate: body.dueDate,
            }),
            ...(body.startAt !== undefined && {
              startAt: toDateOrNull(body.startAt),
            }),
            ...(body.endAt !== undefined && {
              endAt: toDateOrNull(body.endAt),
            }),
            ...(body.occurredAt !== undefined && {
              occurredAt: toDateOrNull(body.occurredAt),
            }),
            ...(body.remindAt !== undefined && {
              remindAt: toDateOrNull(body.remindAt),
            }),
            ...(body.allDay !== undefined && {
              allDay: body.allDay,
            }),
            ...(body.timeZone !== undefined && {
              timeZone: body.timeZone,
            }),
            ...(body.location !== undefined && {
              location: body.location,
            }),
            ...(body.onlineMeetingUrl !== undefined && {
              onlineMeetingUrl: body.onlineMeetingUrl,
            }),
            ...(body.availability !== undefined && {
              availability: agendaFields.availability,
            }),
            ...(body.sensitivity !== undefined && {
              sensitivity: agendaFields.sensitivity,
            }),
            ...(body.organizer !== undefined && {
              organizer: body.organizer,
            }),
            ...(body.attendees !== undefined && {
              attendees: agendaFields.attendees,
            }),
            ...(body.recurrence !== undefined && {
              recurrence: body.recurrence,
            }),
            ...(body.sortOrder !== undefined && {
              sortOrder: body.sortOrder,
            }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(entities.id, body.taskId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
              eq(entities.readOnly, false),
            ),
          )
          .returning({ id: entities.id }),
      ),
    );

    if (updated.length === 0) {
      const [task] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ readOnly: entities.readOnly })
            .from(entities)
            .where(
              and(
                eq(entities.id, body.taskId),
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "task"),
              ),
            )
            .limit(1),
        ),
      );

      if (task?.readOnly) {
        return Result.err(
          new HandlerError({ status: 409, message: "Task is read-only" }),
        );
      }

      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default updateTask;
