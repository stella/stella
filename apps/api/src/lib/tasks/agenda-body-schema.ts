import { t } from "elysia";

import { LIMITS } from "@/api/lib/limits";

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

/** The optional agenda fields a task create or update body accepts. */
export const agendaBodyFields = {
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
};
