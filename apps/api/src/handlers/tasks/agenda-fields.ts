import type {
  AgendaAttendee,
  AgendaAvailability,
  AgendaSensitivity,
} from "@/api/db/schema";
import {
  AGENDA_ATTENDEE_TYPES,
  AGENDA_AVAILABILITIES,
  AGENDA_SENSITIVITIES,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { includes } from "@/api/lib/type-guards";

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
