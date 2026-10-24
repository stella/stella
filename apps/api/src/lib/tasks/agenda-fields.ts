import * as v from "valibot";

import { API_STORABLE_INSTANT_CHECK } from "@stll/api-contract/api-date";

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

const agendaDateTimeSchema = v.nullable(
  v.pipe(
    v.string(),
    v.isoTimestamp(),
    API_STORABLE_INSTANT_CHECK,
    v.maxLength(AGENDA_DATE_TIME_MAX_LENGTH),
  ),
);
const agendaParticipantSchema = v.object({
  email: v.nullable(v.pipe(v.string(), v.email(), v.maxLength(320))),
  name: v.nullable(v.pipe(v.string(), v.maxLength(512))),
});
const agendaAttendeeSchema = v.object({
  email: v.nullable(v.pipe(v.string(), v.email(), v.maxLength(320))),
  name: v.nullable(v.pipe(v.string(), v.maxLength(512))),
  optional: v.exactOptional(v.boolean()),
  responseStatus: v.exactOptional(
    v.nullable(v.pipe(v.string(), v.maxLength(64))),
  ),
  type: v.exactOptional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
});
const agendaRecurrenceSchema = v.object({
  pattern: v.nullable(v.pipe(v.string(), v.maxLength(2000))),
  range: v.nullable(v.pipe(v.string(), v.maxLength(2000))),
});

/**
 * The agenda properties a task create and a task update body both accept.
 * Callers spread its `properties` into their own body object.
 */
export const agendaFieldsBodySchema = v.object({
  startAt: v.optional(agendaDateTimeSchema),
  endAt: v.optional(agendaDateTimeSchema),
  occurredAt: v.optional(agendaDateTimeSchema),
  remindAt: v.optional(agendaDateTimeSchema),
  allDay: v.optional(v.boolean()),
  timeZone: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64)))),
  location: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(1000)))),
  onlineMeetingUrl: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(2048))),
  ),
  availability: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  sensitivity: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  organizer: v.optional(v.nullable(agendaParticipantSchema)),
  attendees: v.optional(
    v.nullable(
      v.pipe(
        v.array(agendaAttendeeSchema),
        v.maxLength(LIMITS.agendaAttendeesMax),
      ),
    ),
  ),
  recurrence: v.optional(v.nullable(agendaRecurrenceSchema)),
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
