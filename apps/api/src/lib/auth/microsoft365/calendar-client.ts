import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  MICROSOFT365_CALENDAR_ATTENDEE_CAP as CALENDAR_ATTENDEE_CAP,
  MICROSOFT365_CALENDAR_RANGE_DAYS as CALENDAR_RANGE_DAYS,
  MICROSOFT365_CALENDAR_RUNTIME_ONLY_CHECKS,
  MICROSOFT365_CALENDAR_TOTAL_CAP as CALENDAR_TOTAL_CAP,
  microsoft365CalendarRangeEntries,
} from "@stll/api-contract/microsoft365";
import { Temporal } from "@stll/time";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { AccessToken } from "@/api/lib/secret-brands";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const CALENDAR_PAGE_SIZE = 50;
const CALENDAR_AVAILABILITY_SLOTS_PER_DAY = 48;
// Bound each untrusted text field as well as the number and bytes of results.
const CALENDAR_SUBJECT_MAX_LENGTH = 512;
const CALENDAR_LOCATION_MAX_LENGTH = 256;
const CALENDAR_ORGANIZER_NAME_MAX_LENGTH = 256;

class CalendarGraphError extends TaggedError("CalendarGraphError")<{
  message: string;
  kind: "needs_reconnect" | "capability_missing" | "throttled" | "upstream";
  retryAfter: number | null;
  cause?: unknown;
}> {}

const upstreamError = (cause: unknown) =>
  new CalendarGraphError({
    message: "Calendar request failed",
    kind: "upstream",
    retryAfter: null,
    cause,
  });
const graphDateTime = v.object({
  dateTime: v.pipe(v.string(), v.maxLength(64)),
  timeZone: v.pipe(v.string(), v.maxLength(64)),
});
const eventSchema = v.object({
  showAs: v.optional(v.pipe(v.string(), v.maxLength(32)), "unknown"),
  id: v.pipe(v.string(), v.maxLength(1024)),
  subject: v.optional(v.string(), ""),
  start: graphDateTime,
  end: graphDateTime,
  location: v.optional(v.object({ displayName: v.optional(v.string(), "") })),
  organizer: v.optional(
    v.object({
      emailAddress: v.object({
        name: v.optional(v.string()),
        address: v.optional(v.pipe(v.string(), v.maxLength(254))),
      }),
    }),
  ),
  attendees: v.optional(v.array(v.unknown()), []),
  isCancelled: v.optional(v.boolean(), false),
  isOnlineMeeting: v.optional(v.boolean(), false),
  webLink: v.optional(v.pipe(v.string(), v.maxLength(4096))),
});
const toCalendarEvent = (event: v.InferOutput<typeof eventSchema>) => ({
  status: event.showAs,
  id: event.id,
  subject: event.subject.slice(0, CALENDAR_SUBJECT_MAX_LENGTH),
  start: event.start,
  end: event.end,
  location: (event.location?.displayName ?? "").slice(
    0,
    CALENDAR_LOCATION_MAX_LENGTH,
  ),
  organizer: event.organizer
    ? {
        address: event.organizer.emailAddress.address,
        name: event.organizer.emailAddress.name?.slice(
          0,
          CALENDAR_ORGANIZER_NAME_MAX_LENGTH,
        ),
      }
    : null,
  attendeeCount: event.attendees.length,
  isCancelled: event.isCancelled,
  isOnlineMeeting: event.isOnlineMeeting,
  webLink: event.webLink ?? null,
});
const eventsSchema = v.object({
  value: v.pipe(v.array(eventSchema), v.maxLength(CALENDAR_PAGE_SIZE)),
  "@odata.nextLink": v.optional(v.string()),
});
const attendeeScheduleFields = v.object({
  scheduleId: v.pipe(v.string(), v.maxLength(254)),
  availabilityView: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(CALENDAR_RANGE_DAYS * CALENDAR_AVAILABILITY_SLOTS_PER_DAY),
    ),
  ),
  error: v.optional(
    v.object({
      responseCode: v.pipe(v.string(), v.maxLength(64)),
      message: v.pipe(v.string(), v.maxLength(512)),
    }),
  ),
  scheduleItems: v.optional(
    v.pipe(
      v.array(
        v.object({
          status: v.pipe(v.string(), v.maxLength(32)),
          start: graphDateTime,
          end: graphDateTime,
        }),
      ),
      v.maxLength(CALENDAR_TOTAL_CAP),
    ),
  ),
});
const attendeeScheduleSchema = v.pipe(
  attendeeScheduleFields,
  v.check(
    ({ error, availabilityView, scheduleItems }) =>
      error !== undefined ||
      availabilityView !== undefined ||
      scheduleItems !== undefined,
    "Expected availability evidence or an attendee error",
  ),
  // Keep provider field presence through validation before applying defaults.
  v.object({
    ...attendeeScheduleFields.entries,
    scheduleItems: v.optional(
      v.unwrap(attendeeScheduleFields.entries.scheduleItems),
      [],
    ),
  }),
  v.transform(({ scheduleId, error, availabilityView, scheduleItems }) => {
    if (error !== undefined) {
      return { type: "error" as const, scheduleId, error };
    }
    return {
      type: "availability" as const,
      scheduleId,
      availabilityView,
      scheduleItems,
    };
  }),
);
const schedulesSchema = v.object({
  value: v.pipe(
    v.array(attendeeScheduleSchema),
    v.maxLength(CALENDAR_ATTENDEE_CAP),
  ),
});

const calendarRangeSchema = v.pipe(
  v.object(microsoft365CalendarRangeEntries),
  ...MICROSOFT365_CALENDAR_RUNTIME_ONLY_CHECKS,
);
export const calendarEventsInputSchema = v.intersect([
  calendarRangeSchema,
  v.object({
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(CALENDAR_TOTAL_CAP),
      ),
      CALENDAR_TOTAL_CAP,
    ),
  }),
]);
export const calendarFreeBusyInputSchema = v.intersect([
  calendarRangeSchema,
  v.object({
    attendees: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.email(), v.maxLength(254))),
        v.minLength(1),
        v.maxLength(CALENDAR_ATTENDEE_CAP),
      ),
    ),
  }),
]);

const failureForStatus = (status: number) => {
  switch (status) {
    case 401:
      return {
        kind: "needs_reconnect",
        message: "Reconnect Microsoft 365",
      } as const;
    case 403:
      return {
        kind: "capability_missing",
        message: "Calendar capability missing or access denied",
      } as const;
    case 429:
      return {
        kind: "throttled",
        message: "Calendar request throttled",
      } as const;
    default:
      return {
        kind: "upstream",
        message: "Calendar service unavailable",
      } as const;
  }
};

type CalendarClientOptions = {
  accessToken: AccessToken;
  permit: ThirdPartyOutboundPermit;
  signal?: AbortSignal | undefined;
  fetchBytes?: typeof safeOutboundFetchBytes;
};

const requestGraph = async (
  request: {
    path: "/v1.0/me/calendarView" | "/v1.0/me/calendar/getSchedule";
    search?: string;
  },
  options: CalendarClientOptions & { body?: string },
) => {
  const fetched = await Result.tryPromise({
    try: async () => {
      const url = new URL(GRAPH_BASE);
      url.pathname = request.path;
      url.search = request.search ?? "";
      const response = await (options.fetchBytes ?? safeOutboundFetchBytes)({
        url,
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: 'outlook.timezone="UTC"',
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "error",
        maxBytes: RESPONSE_MAX_BYTES,
        permit: options.permit,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: options.signal,
      });
      if (Result.isError(response)) {
        return Result.err(upstreamError(response.error));
      }
      if (!response.value.ok) {
        const retryAfter = parseIntegerToken(
          response.value.headers.get("Retry-After"),
          { sign: "unsigned" },
        ).unwrapOr(null);
        return Result.err(
          new CalendarGraphError({
            ...failureForStatus(response.value.status),
            retryAfter,
          }),
        );
      }
      const data = Result.try((): unknown =>
        JSON.parse(new TextDecoder().decode(response.value.body)),
      );
      return Result.isError(data)
        ? Result.err(upstreamError("Invalid calendar JSON"))
        : Result.ok(data.value);
    },
    catch: upstreamError,
  });
  return Result.isError(fetched) ? fetched : fetched.value;
};

type CalendarContinuation = {
  key: string;
  param: "$skip" | "$skiptoken";
  value: string;
};

// Graph continues calendarView pages with an opaque $skiptoken or a numeric
// $skip offset; any other next link does not continue this request.
const calendarContinuation = (next: URL): CalendarContinuation | undefined => {
  const token = next.searchParams.get("$skiptoken");
  if (token) {
    return { key: `$skiptoken=${token}`, param: "$skiptoken", value: token };
  }
  const offset = next.searchParams.get("$skip");
  if (offset && /^[1-9]\d{0,5}$/u.test(offset)) {
    return { key: `$skip=${offset}`, param: "$skip", value: offset };
  }
  return undefined;
};

export const listCalendarEvents = async (
  input: v.InferInput<typeof calendarEventsInputSchema>,
  options: CalendarClientOptions,
) =>
  await Result.gen(async function* () {
    const validated = v.safeParse(calendarEventsInputSchema, input);
    if (!validated.success) {
      return Result.err(upstreamError("Invalid calendar range or limit"));
    }
    const range = validated.output;
    const url = new URL(`${GRAPH_BASE}/me/calendarView`);
    url.searchParams.set("startDateTime", range.start);
    url.searchParams.set("endDateTime", range.end);
    url.searchParams.set(
      "$select",
      "id,subject,showAs,start,end,location,organizer,attendees,isCancelled,isOnlineMeeting,webLink",
    );
    url.searchParams.set("$orderby", "start/dateTime");
    const events: ReturnType<typeof toCalendarEvent>[] = [];
    const seen = new Set<string>();
    const maxPages = Math.ceil(CALENDAR_TOTAL_CAP / CALENDAR_PAGE_SIZE);
    for (let page = 0; page < maxPages; page += 1) {
      const requestedPageSize = Math.min(
        CALENDAR_PAGE_SIZE,
        range.limit - events.length,
      );
      url.searchParams.set("$top", String(requestedPageSize));
      const raw = yield* Result.await(
        requestGraph(
          { path: "/v1.0/me/calendarView", search: url.search },
          options,
        ),
      );
      const parsed = v.safeParse(eventsSchema, raw);
      if (!parsed.success) {
        return Result.err(upstreamError("Invalid calendar response"));
      }
      for (const event of parsed.output.value.slice(
        0,
        range.limit - events.length,
      )) {
        events.push(toCalendarEvent(event));
      }
      const next = parsed.output["@odata.nextLink"];
      if (!next) {
        return Result.ok({
          events,
          truncated: parsed.output.value.length > requestedPageSize,
        });
      }
      if (events.length >= range.limit || page + 1 === maxPages) {
        return Result.ok({ events, truncated: true });
      }
      const nextUrl = URL.parse(next);
      const continuation =
        nextUrl?.origin === url.origin && nextUrl.pathname === url.pathname
          ? calendarContinuation(nextUrl)
          : undefined;
      if (!continuation || seen.has(continuation.key)) {
        return Result.err(upstreamError("Invalid calendar continuation"));
      }
      seen.add(continuation.key);
      url.searchParams.delete("$skiptoken");
      url.searchParams.delete("$skip");
      url.searchParams.set(continuation.param, continuation.value);
    }
    return Result.ok({ events, truncated: true });
  });

export const calendarFreeBusy = async (
  input: v.InferInput<typeof calendarFreeBusyInputSchema>,
  options: CalendarClientOptions,
) =>
  await Result.gen(async function* () {
    const validated = v.safeParse(calendarFreeBusyInputSchema, input);
    if (!validated.success) {
      return Result.err(upstreamError("Invalid free/busy range or attendees"));
    }
    if (!validated.output.attendees) {
      const own = yield* Result.await(
        listCalendarEvents(
          { start: input.start, end: input.end, limit: CALENDAR_TOTAL_CAP },
          options,
        ),
      );
      // A truncated calendar cannot establish availability; return the limit explicitly.
      return Result.ok({
        type: "own_calendar" as const,
        truncated: own.truncated,
        events: own.events
          .filter(({ isCancelled }) => !isCancelled)
          .map(({ start, end, status }) => ({
            start,
            end,
            status,
          })),
      });
    }
    const requestedSchedules = new Map<string, string>();
    for (const attendee of validated.output.attendees) {
      const key = attendee.toLowerCase();
      if (!requestedSchedules.has(key)) {
        requestedSchedules.set(key, attendee);
      }
    }
    const raw = yield* Result.await(
      requestGraph(
        { path: "/v1.0/me/calendar/getSchedule" },
        {
          ...options,
          body: JSON.stringify({
            schedules: [...requestedSchedules.values()],
            startTime: {
              dateTime: Temporal.Instant.from(input.start).toString(),
              timeZone: "UTC",
            },
            endTime: {
              dateTime: Temporal.Instant.from(input.end).toString(),
              timeZone: "UTC",
            },
            availabilityViewInterval: 30,
          }),
        },
      ),
    );
    const parsed = v.safeParse(schedulesSchema, raw);
    if (!parsed.success) {
      return Result.err(upstreamError("Invalid free/busy response"));
    }
    const coveredSchedules = new Set<string>();
    for (const schedule of parsed.output.value) {
      const key = schedule.scheduleId.toLowerCase();
      if (!requestedSchedules.has(key) || coveredSchedules.has(key)) {
        return Result.err(upstreamError("Invalid free/busy schedule identity"));
      }
      coveredSchedules.add(key);
    }
    if (coveredSchedules.size !== requestedSchedules.size) {
      return Result.err(upstreamError("Incomplete free/busy response"));
    }
    return Result.ok({
      type: "attendees" as const,
      schedules: parsed.output.value,
    });
  });
