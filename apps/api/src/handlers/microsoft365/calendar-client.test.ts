import { Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import type { fetchWithTimeout } from "@stll/fetch";

import { secretSchema } from "@/api/lib/secret-brands";

import {
  calendarEventsInputSchema,
  calendarFreeBusyInputSchema,
  calendarFreeBusy,
  listCalendarEvents,
} from "./calendar-client";

const accessToken = v.parse(secretSchema, "calendar-token");
const range = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };
const event = {
  id: "event-1",
  subject: "Consultation",
  start: { dateTime: "2026-10-01T10:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-10-01T11:00:00", timeZone: "UTC" },
  attendees: [{ emailAddress: { address: "a@example.test" } }],
  showAs: "busy",
  body: { content: "omitted" },
};

test("calendar schemas bound ranges, event limits, and attendee counts", () => {
  expect(
    v.safeParse(calendarEventsInputSchema, { ...range, limit: 200 }).success,
  ).toBe(true);
  expect(
    v.safeParse(calendarEventsInputSchema, {
      ...range,
      end: "2026-11-02T00:00:00Z",
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(calendarEventsInputSchema, { ...range, start: range.end })
      .success,
  ).toBe(false);
  expect(
    v.safeParse(calendarEventsInputSchema, { ...range, limit: 201 }).success,
  ).toBe(false);
  expect(
    v.safeParse(calendarFreeBusyInputSchema, {
      ...range,
      attendees: Array.from({ length: 21 }, () => "a@example.test"),
    }).success,
  ).toBe(false);
});

test("event reads select metadata, omit bodies and stop at the total paging cap", async () => {
  const requests: URL[] = [];
  const fetcher: typeof fetchWithTimeout = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(init?.redirect).toBe("error");
    expect(url.searchParams.get("$select")).not.toContain("body");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({
      value: Array.from({ length: 50 }, () => event),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page${requests.length}`,
    });
  };
  const result = await listCalendarEvents(
    { ...range, limit: 200 },
    { accessToken, fetcher },
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    return;
  }
  expect(result.value.events).toHaveLength(200);
  expect(result.value.truncated).toBe(true);
  expect(result.value.events.at(0)).toMatchObject({
    attendeeCount: 1,
    subject: "Consultation",
  });
  expect(result.value.events.at(0)).not.toHaveProperty("body");
  expect(requests).toHaveLength(4);
});

test("Graph failures retain actionable reconnect, permission and throttle semantics", async () => {
  for (const [status, kind] of [
    [401, "needs_reconnect"],
    [403, "capability_missing"],
    [429, "throttled"],
    [503, "upstream"],
  ] as const) {
    const result = await listCalendarEvents(
      { ...range, limit: 1 },
      {
        accessToken,
        fetcher: async () =>
          new Response(null, { status, headers: { "Retry-After": "60" } }),
      },
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ kind, retryAfter: 60 });
    }
  }
});

test("free/busy sends bounded attendee schedules and strips subject fields", async () => {
  const result = await calendarFreeBusy(
    { ...range, attendees: ["a@example.test"] },
    {
      accessToken,
      fetcher: async (url, init) => {
        expect(String(url)).toEndWith("/me/calendar/getSchedule");
        expect(JSON.parse(String(init?.body)).schedules).toEqual([
          "a@example.test",
        ]);
        return Response.json({
          value: [
            {
              scheduleId: "a@example.test",
              scheduleItems: [
                {
                  status: "busy",
                  start: event.start,
                  end: event.end,
                  subject: "private",
                },
              ],
            },
          ],
        });
      },
    },
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isOk(result)) {
    expect(JSON.stringify(result.value)).not.toContain("private");
  }
});

test("calendar continuations stay on the original Graph endpoint", async () => {
  let requests = 0;
  const result = await listCalendarEvents(range, {
    accessToken,
    fetcher: async () => {
      requests += 1;
      return Response.json({
        value: [],
        "@odata.nextLink":
          "https://calendar.example.test/v1.0/me/calendarView?$skiptoken=next",
      });
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(requests).toBe(1);
});

test("calendar responses enforce the byte ceiling before parsing", async () => {
  const result = await listCalendarEvents(range, {
    accessToken,
    fetcher: async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.kind).toBe("upstream");
  }
});
