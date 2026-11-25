import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_CALENDAR_EVENTS_LIMIT,
  desktopCalendarEventSchema,
} from "@stll/api-contract/desktop-time-entries";

import type { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import {
  dayReviewEvent,
  listDayReviewEvents,
} from "@/api/lib/auth/microsoft365/calendar-client";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { secretSchema } from "@/api/lib/secret-brands";

const permit = grantThirdPartyOutboundPermit();
const accessToken = v.parse(secretSchema, "calendar-token");
const range = { start: "2026-10-01T22:00:00Z", end: "2026-10-02T22:00:00Z" };

const jsonResponse = (value: unknown) =>
  Result.ok({
    body: new TextEncoder().encode(JSON.stringify(value)).buffer,
    headers: new Headers(),
    ok: true,
    status: 200,
  });

const graphEvent = {
  subject: "Hearing, Novák v. Svoboda",
  start: { dateTime: "2026-10-02T08:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-02T09:30:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  sensitivity: "normal",
  responseStatus: { response: "accepted" },
};

test("a kept timed event carries its title, instants and own answer only", () => {
  expect(dayReviewEvent(graphEvent)).toEqual({
    timing: "timed",
    title: "Hearing, Novák v. Svoboda",
    start: "2026-10-02T08:00:00Z",
    end: "2026-10-02T09:30:00Z",
    response: "accepted",
  });
});

test("private, personal, confidential and unmarked events are never returned", () => {
  for (const sensitivity of [
    "private",
    "personal",
    "confidential",
    "unknown",
  ]) {
    expect(dayReviewEvent({ ...graphEvent, sensitivity })).toBeNull();
  }
});

test("declined, cancelled and unknown answers are never returned", () => {
  for (const response of ["declined", "unknown", "constructor"]) {
    expect(
      dayReviewEvent({ ...graphEvent, responseStatus: { response } }),
    ).toBeNull();
  }
  expect(dayReviewEvent({ ...graphEvent, isCancelled: true })).toBeNull();
});

test("answers map to the member's own response", () => {
  for (const [response, expected] of [
    ["organizer", "organizer"],
    ["accepted", "accepted"],
    ["tentativelyAccepted", "tentative"],
    ["none", "notAnswered"],
    ["notResponded", "notAnswered"],
  ] as const) {
    expect(
      dayReviewEvent({ ...graphEvent, responseStatus: { response } })?.response,
    ).toBe(expected);
  }
});

test("an all-day event carries no time and still skips private and declined", () => {
  const allDay = { ...graphEvent, isAllDay: true };
  expect(dayReviewEvent(allDay)).toEqual({
    timing: "allDay",
    title: "Hearing, Novák v. Svoboda",
    response: "accepted",
  });
  expect(dayReviewEvent({ ...allDay, sensitivity: "private" })).toBeNull();
  expect(
    dayReviewEvent({ ...allDay, responseStatus: { response: "declined" } }),
  ).toBeNull();
});

test("titles lose control characters and stay within the contract", () => {
  const kept = dayReviewEvent({
    ...graphEvent,
    subject: `Call\nwith\tclient ${"x".repeat(400)}`,
  });
  expect(kept?.title.startsWith("Call with client x")).toBe(true);
  expect(v.safeParse(desktopCalendarEventSchema, kept).success).toBe(true);
  expect(dayReviewEvent({ ...graphEvent, subject: null })?.title).toBe("");
  const emoji = dayReviewEvent({
    ...graphEvent,
    subject: `${"x".repeat(255)}📅`,
  });
  expect(emoji?.title).toBe("x".repeat(255));
});

test("an event whose time cannot be read or has no duration is dropped", () => {
  expect(
    dayReviewEvent({
      ...graphEvent,
      start: { dateTime: "not a time", timeZone: "UTC" },
    }),
  ).toBeNull();
  expect(dayReviewEvent({ ...graphEvent, end: graphEvent.start })).toBeNull();
});

test("the day read selects no attendee, organizer, location or body", async () => {
  const requests: URL[] = [];
  const fetchBytes: typeof safeOutboundFetchBytes = async (input) => {
    const url = new URL(input.url);
    requests.push(url);
    return jsonResponse({
      value: [
        graphEvent,
        { ...graphEvent, sensitivity: "private" },
        { ...graphEvent, responseStatus: { response: "declined" } },
      ],
    });
  };
  const result = await listDayReviewEvents(range, {
    accessToken,
    fetchBytes,
    permit,
  });
  if (Result.isError(result)) {
    return panic("Expected the day read to succeed");
  }
  expect(result.value.events).toHaveLength(1);
  expect(result.value.truncated).toBe(false);
  const select = requests.at(0)?.searchParams.get("$select") ?? "";
  for (const field of [
    "attendees",
    "organizer",
    "location",
    "body",
    "webLink",
  ]) {
    expect(select).not.toContain(field);
  }
  expect(requests.at(0)?.searchParams.get("startDateTime")).toBe(range.start);
  expect(requests.at(0)?.searchParams.get("endDateTime")).toBe(range.end);
});

test("a day with more events than the limit reports itself truncated", async () => {
  let page = 0;
  const fetchBytes: typeof safeOutboundFetchBytes = async () => {
    page += 1;
    return jsonResponse({
      value: Array.from({ length: 50 }, () => graphEvent),
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page${page}`,
    });
  };
  const result = await listDayReviewEvents(range, {
    accessToken,
    fetchBytes,
    permit,
  });
  if (Result.isError(result)) {
    return panic("Expected the day read to succeed");
  }
  expect(result.value.events).toHaveLength(DESKTOP_CALENDAR_EVENTS_LIMIT);
  expect(result.value.truncated).toBe(true);
});
