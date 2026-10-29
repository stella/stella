import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import type { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import {
  calendarEventsInputSchema,
  calendarFreeBusy,
  calendarFreeBusyInputSchema,
  listCalendarEvents,
} from "@/api/lib/auth/microsoft365/calendar-client";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { SafeOutboundFetchError } from "@/api/lib/safe-outbound-fetch";
import { secretSchema } from "@/api/lib/secret-brands";

const permit = grantThirdPartyOutboundPermit();
const jsonResponse = (value: unknown, status = 200, headers = new Headers()) =>
  Result.ok({
    body: new TextEncoder().encode(JSON.stringify(value)).buffer,
    headers,
    ok: status >= 200 && status < 300,
    status,
  });

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
  const fetchBytes: typeof safeOutboundFetchBytes = async (input) => {
    const url = new URL(input.url);
    requests.push(url);
    expect(input.redirect).toBe("error");
    expect(url.searchParams.get("$select")).not.toContain("body");
    expect(input.timeoutMs).toBe(10_000);
    return jsonResponse({
      value: Array.from({ length: 50 }, () => event),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page${requests.length}`,
    });
  };
  const result = await listCalendarEvents(
    { ...range, limit: 200 },
    { accessToken, fetchBytes, permit },
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
        permit,
        fetchBytes: async () =>
          jsonResponse(null, status, new Headers({ "Retry-After": "60" })),
      },
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ kind, retryAfter: 60 });
    }
  }
});

test("malformed Graph JSON does not surface provider content through the error cause", async () => {
  const privateText = "privileged-calendar-subject";
  const result = await listCalendarEvents(range, {
    accessToken,
    permit,
    fetchBytes: async () =>
      Result.ok({
        body: new TextEncoder().encode(`{"subject":"${privateText}"`).buffer,
        headers: new Headers(),
        ok: true,
        status: 200,
      }),
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      kind: "upstream",
      cause: "Invalid calendar JSON",
    });
    expect(JSON.stringify(result.error)).not.toContain(privateText);
  }
});

test("Graph retry hints accept only safe unsigned whole seconds", async () => {
  for (const retryAfter of ["1e9", "-1", "9007199254740992"]) {
    const result = await listCalendarEvents(
      { ...range, limit: 1 },
      {
        accessToken,
        permit,
        fetchBytes: async () =>
          jsonResponse(null, 429, new Headers({ "Retry-After": retryAfter })),
      },
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        kind: "throttled",
        retryAfter: null,
      });
    }
  }
});

test("free/busy sends bounded attendee schedules and strips subject fields", async () => {
  const result = await calendarFreeBusy(
    { ...range, attendees: ["a@example.test"] },
    {
      accessToken,
      permit,
      fetchBytes: async (request) => {
        expect(new URL(request.url).pathname).toBe(
          "/v1.0/me/calendar/getSchedule",
        );
        if (typeof request.body !== "string") {
          return panic("Expected serialized schedule body");
        }
        expect(JSON.parse(request.body).schedules).toEqual(["a@example.test"]);
        return jsonResponse({
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

test("free/busy refuses omitted, duplicate, and unexpected attendee schedules", async () => {
  const attendeeA = "a@example.test";
  const attendees = [attendeeA, "b@example.test"];
  const present = { scheduleId: attendeeA, scheduleItems: [] };
  for (const schedules of [
    [],
    [present],
    [present, { ...present, scheduleId: "A@example.test" }],
    [present, { scheduleId: "c@example.test", scheduleItems: [] }],
  ]) {
    const result = await calendarFreeBusy(
      { ...range, attendees },
      {
        accessToken,
        permit,
        fetchBytes: async ({ body }) => {
          if (typeof body !== "string") {
            return panic("Expected serialized schedule body");
          }
          expect(JSON.parse(body).schedules).toEqual(attendees);
          return jsonResponse({ value: schedules });
        },
      },
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("upstream");
    }
  }
});

test("free/busy retains explicit per-attendee errors with complete coverage", async () => {
  const result = await calendarFreeBusy(
    { ...range, attendees: ["a@example.test", "b@example.test"] },
    {
      accessToken,
      permit,
      fetchBytes: async () =>
        jsonResponse({
          value: [
            {
              scheduleId: "A@example.test",
              error: {
                responseCode: "ErrorMailRecipientNotFound",
                message: "Attendee unavailable",
              },
            },
            { scheduleId: "b@example.test", scheduleItems: [] },
          ],
        }),
    },
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isOk(result)) {
    if (result.value.type !== "attendees") {
      return panic("Expected attendee availability response");
    }
    expect(result.value.schedules.at(0)?.error).toMatchObject({
      responseCode: "ErrorMailRecipientNotFound",
    });
  }
});

test("free/busy rejects an overlong provider error field", async () => {
  const result = await calendarFreeBusy(
    { ...range, attendees: ["a@example.test"] },
    {
      accessToken,
      permit,
      fetchBytes: async () =>
        jsonResponse({
          value: [
            {
              scheduleId: "a@example.test",
              error: { responseCode: "Error", message: "x".repeat(513) },
            },
          ],
        }),
    },
  );
  expect(Result.isError(result)).toBe(true);
});

test("calendar continuations stay on the original Graph endpoint", async () => {
  let requests = 0;
  const result = await listCalendarEvents(range, {
    accessToken,
    permit,
    fetchBytes: async () => {
      requests += 1;
      return jsonResponse({
        value: [],
        "@odata.nextLink":
          "https://calendar.example.test/v1.0/me/calendarView?$skiptoken=next",
      });
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(requests).toBe(1);
});

test("calendar reads follow numeric $skip continuations to the last page", async () => {
  const requests: URL[] = [];
  const result = await listCalendarEvents(
    { ...range, limit: 120 },
    {
      accessToken,
      permit,
      fetchBytes: async (input) => {
        const url = new URL(input.url);
        requests.push(url);
        const skip = Number(url.searchParams.get("$skip") ?? "0");
        return jsonResponse({
          value: Array.from({ length: skip === 100 ? 20 : 50 }, () => event),
          "@odata.nextLink":
            skip < 100
              ? `https://graph.microsoft.com/v1.0/me/calendarView?$top=50&$skip=${skip + 50}`
              : undefined,
        });
      },
    },
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    return;
  }
  expect(result.value.events).toHaveLength(120);
  expect(result.value.truncated).toBe(false);
  expect(requests.map((url) => url.searchParams.get("$skip"))).toEqual([
    null,
    "50",
    "100",
  ]);
  expect(requests.every((url) => !url.searchParams.has("$skiptoken"))).toBe(
    true,
  );
});

test("calendar continuations reject non-numeric $skip offsets", async () => {
  let requests = 0;
  const result = await listCalendarEvents(range, {
    accessToken,
    permit,
    fetchBytes: async () => {
      requests += 1;
      return jsonResponse({
        value: [],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView?$skip=1e9",
      });
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(requests).toBe(1);
});

test("calendar responses enforce the byte ceiling before parsing", async () => {
  // Recorded rather than asserted in the transport: the client converts a
  // throwing transport into the same upstream error this test expects.
  const ceilings: (number | undefined)[] = [];
  const result = await listCalendarEvents(range, {
    accessToken,
    permit,
    fetchBytes: async ({ maxBytes }) => {
      ceilings.push(maxBytes);
      return Result.err(
        new SafeOutboundFetchError({
          message: "Response body exceeded size limit",
        }),
      );
    },
  });
  expect(ceilings).toEqual([2 * 1024 * 1024]);
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.kind).toBe("upstream");
  }
});

test("calendar event text fields have independent model-facing length bounds", async () => {
  const longText = "Ž".repeat(1024);
  const result = await listCalendarEvents(
    { ...range, limit: 1 },
    {
      accessToken,
      permit,
      fetchBytes: async () =>
        jsonResponse({
          value: [
            {
              ...event,
              subject: longText,
              location: { displayName: longText },
              organizer: {
                emailAddress: {
                  name: longText,
                  address: "organizer@example.test",
                },
              },
            },
          ],
        }),
    },
  );
  const first = result.unwrap().events.at(0);
  expect(first?.subject).toBe(longText.slice(0, 512));
  expect(first?.location).toBe(longText.slice(0, 256));
  expect(first?.organizer?.name).toBe(longText.slice(0, 256));
});
