import { t } from "elysia";

import type { AgendaAttendee } from "@/api/db/schema";
import {
  AGENDA_ATTENDEE_TYPES,
  AGENDA_AVAILABILITIES,
  AGENDA_SENSITIVITIES,
} from "@/api/lib/entity-constants";
import type {
  AgendaAvailability,
  AgendaSensitivity,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { includes } from "@/api/lib/type-guards";

// No valid ISO-8601 timestamp comes near this length; the bound only stops an
// unbounded fraction from riding the date-time format.
const AGENDA_DATE_TIME_MAX_LENGTH = 64;

const agendaDateTimeSchema = t.Nullable(
  t.String({ format: "date-time", maxLength: AGENDA_DATE_TIME_MAX_LENGTH }),
);
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

/**
 * The agenda properties a task create and a task update body both accept.
 * Callers spread its `properties` into their own body object.
 */
export const agendaFieldsBodySchema = t.Object({
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
});

type AgendaAttendeeInput = {
  email: string | null;
  name: string | null;
  optional?: boolean;
  responseStatus?: string | null;
  type?: string | null;
};

type AgendaFieldValidationResult =
  | {
      attendees: AgendaAttendee[] | null | undefined;
      availability: AgendaAvailability | null | undefined;
      sensitivity: AgendaSensitivity | null | undefined;
      status: "ok";
    }
  | { error: HandlerError; status: "error" };

type ValidateAgendaFieldsOptions = {
  attendees: AgendaAttendeeInput[] | null | undefined;
  availability: string | null | undefined;
  sensitivity: string | null | undefined;
};

export const validateAgendaFields = ({
  attendees,
  availability,
  sensitivity,
}: ValidateAgendaFieldsOptions): AgendaFieldValidationResult => {
  if (
    availability !== undefined &&
    availability !== null &&
    !includes(AGENDA_AVAILABILITIES, availability)
  ) {
    return {
      error: new HandlerError({
        status: 400,
        message: "Invalid availability",
      }),
      status: "error",
    };
  }
  if (
    sensitivity !== undefined &&
    sensitivity !== null &&
    !includes(AGENDA_SENSITIVITIES, sensitivity)
  ) {
    return {
      error: new HandlerError({
        status: 400,
        message: "Invalid sensitivity",
      }),
      status: "error",
    };
  }

  if (attendees === undefined || attendees === null) {
    return {
      attendees,
      availability,
      sensitivity,
      status: "ok",
    };
  }

  const normalizedAttendees: AgendaAttendee[] = [];
  for (const attendee of attendees) {
    if (
      attendee.type !== undefined &&
      attendee.type !== null &&
      !includes(AGENDA_ATTENDEE_TYPES, attendee.type)
    ) {
      return {
        error: new HandlerError({
          status: 400,
          message: "Invalid attendee type",
        }),
        status: "error",
      };
    }

    normalizedAttendees.push({
      email: attendee.email,
      name: attendee.name,
      ...(attendee.optional !== undefined && { optional: attendee.optional }),
      ...(attendee.responseStatus !== undefined && {
        responseStatus: attendee.responseStatus,
      }),
      ...(attendee.type !== undefined && { type: attendee.type }),
    });
  }

  return {
    attendees: normalizedAttendees,
    availability,
    sensitivity,
    status: "ok",
  };
};
