import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  MICROSOFT365_CALENDAR_TOTAL_CAP as CALENDAR_TOTAL_CAP,
  MICROSOFT365_CALENDAR_ATTENDEE_CAP as CALENDAR_ATTENDEE_CAP,
  microsoft365CalendarRangeEntries,
  MICROSOFT365_CALENDAR_RUNTIME_ONLY_CHECKS,
} from "@stll/api-contract/microsoft365";
import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";
import { Temporal } from "@stll/time";

import type { AccessToken } from "@/api/lib/secret-brands";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const CALENDAR_PAGE_SIZE = 50;

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
const graphDateTime = v.object({ dateTime: v.string(), timeZone: v.string() });
const eventSchema = v.object({
  showAs: v.optional(v.string(), "unknown"),
  id: v.string(),
  subject: v.optional(v.string(), ""),
  start: graphDateTime,
  end: graphDateTime,
  location: v.optional(v.object({ displayName: v.optional(v.string(), "") })),
  organizer: v.optional(
    v.object({
      emailAddress: v.object({
        name: v.optional(v.string()),
        address: v.optional(v.string()),
      }),
    }),
  ),
  attendees: v.optional(v.array(v.unknown()), []),
  isOnlineMeeting: v.optional(v.boolean(), false),
  webLink: v.optional(v.string()),
});
const toCalendarEvent = (event: v.InferOutput<typeof eventSchema>) => ({
  status: event.showAs,
  id: event.id,
  subject: event.subject,
  start: event.start,
  end: event.end,
  location: event.location?.displayName ?? "",
  organizer: event.organizer?.emailAddress ?? null,
  attendeeCount: event.attendees.length,
  isOnlineMeeting: event.isOnlineMeeting,
  webLink: event.webLink ?? null,
});
const eventsSchema = v.object({
  value: v.pipe(v.array(eventSchema), v.maxLength(CALENDAR_PAGE_SIZE)),
  "@odata.nextLink": v.optional(v.string()),
});
const schedulesSchema = v.object({
  value: v.pipe(
    v.array(
      v.object({
        scheduleId: v.string(),
        availabilityView: v.optional(v.string()),
        error: v.optional(
          v.object({ responseCode: v.string(), message: v.string() }),
        ),
        scheduleItems: v.optional(
          v.pipe(
            v.array(
              v.object({
                status: v.string(),
                start: graphDateTime,
                end: graphDateTime,
              }),
            ),
            v.maxLength(CALENDAR_TOTAL_CAP),
          ),
          [],
        ),
      }),
    ),
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

const requestGraph = async (
  request: {
    path: "/v1.0/me/calendarView" | "/v1.0/me/calendar/getSchedule";
    search?: string;
  },
  options: {
    accessToken: AccessToken;
    body?: string;
    fetcher?: typeof fetchWithTimeout;
  },
) => {
  const fetched = await Result.tryPromise({
    try: async () => {
      const url = new URL(GRAPH_BASE);
      url.pathname = request.path;
      url.search = request.search ?? "";
      const response = await (options.fetcher ?? fetchWithTimeout)(url, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Prefer: 'outlook.timezone="UTC"',
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "error",
        timeout: { type: "idle", ms: REQUEST_TIMEOUT_MS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retryHeader = response.headers.get("Retry-After");
        const retrySeconds =
          retryHeader === null ? Number.NaN : Number(retryHeader);
        const retryAfter =
          Number.isFinite(retrySeconds) && retrySeconds >= 0
            ? Math.ceil(retrySeconds)
            : null;
        return Result.err(
          new CalendarGraphError({
            ...failureForStatus(response.status),
            retryAfter,
          }),
        );
      }
      if (!response.body) {
        return Result.err(upstreamError("Missing calendar response body"));
      }
      const bytes = await readCappedBytes(response.body, RESPONSE_MAX_BYTES);
      if (!bytes) {
        return Result.err(
          upstreamError("Calendar response exceeds byte limit"),
        );
      }
      const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return Result.ok(data);
    },
    catch: upstreamError,
  });
  return Result.isError(fetched) ? fetched : fetched.value;
};

type CalendarClientOptions = {
  accessToken: AccessToken;
  fetcher?: typeof fetchWithTimeout;
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
      "id,subject,showAs,start,end,location,organizer,attendees,isOnlineMeeting,webLink",
    );
    url.searchParams.set("$orderby", "start/dateTime");
    const events: ReturnType<typeof toCalendarEvent>[] = [];
    const seen = new Set<string>();
    const maxPages = Math.ceil(CALENDAR_TOTAL_CAP / CALENDAR_PAGE_SIZE);
    for (let page = 0; page < maxPages; page += 1) {
      url.searchParams.set(
        "$top",
        String(Math.min(CALENDAR_PAGE_SIZE, range.limit - events.length)),
      );
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
          truncated:
            parsed.output.value.length > Number(url.searchParams.get("$top")),
        });
      }
      if (events.length >= range.limit || page + 1 === maxPages) {
        return Result.ok({ events, truncated: true });
      }
      const nextUrl = URL.parse(next);
      const skip = nextUrl?.searchParams.get("$skiptoken");
      if (
        nextUrl?.origin !== url.origin ||
        nextUrl.pathname !== url.pathname ||
        !skip ||
        seen.has(skip)
      ) {
        return Result.err(upstreamError("Invalid calendar continuation"));
      }
      seen.add(skip);
      url.searchParams.set("$skiptoken", skip);
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
    if (!input.attendees) {
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
        events: own.events.map(({ start, end, status }) => ({
          start,
          end,
          status,
        })),
      });
    }
    const raw = yield* Result.await(
      requestGraph(
        { path: "/v1.0/me/calendar/getSchedule" },
        {
          ...options,
          body: JSON.stringify({
            schedules: input.attendees,
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
    return Result.ok({
      type: "attendees" as const,
      schedules: parsed.output.value,
    });
  });
