import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { DesktopCalendarEvent } from "@stll/api-contract/desktop-time-entries";
import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  calendarDayRange,
  calendarEventLane,
  callEventTitle,
  parseActivityCalendarDay,
} from "../src/activity/activity-calendar-events";
import type { ActivityCalendarDay } from "../src/activity/activity-calendar-events";
import type { TimedSegment } from "../src/activity/activity-logic";

const TIME_ZONE = "Europe/Prague";
const DATE = "2026-10-02";
const dayRange = calendarDayRange(DATE, TIME_ZONE);
const MINUTE = 60_000;
const at = (hour: number, minute = 0) =>
  Temporal.PlainDate.from(DATE).toZonedDateTime({
    timeZone: TIME_ZONE,
    plainTime: Temporal.PlainTime.from({ hour, minute }),
  }).epochMilliseconds;
const iso = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toString();

const segment = (
  app: string,
  startMs: number,
  endMs: number,
  call = false,
): TimedSegment => ({
  appIdentifier: app,
  appName: app,
  document: null,
  windowTitle: null,
  matterId: null,
  call,
  startMs,
  endMs,
});

const timed = (
  title: string,
  startMs: number,
  endMs: number,
): DesktopCalendarEvent => ({
  timing: "timed",
  title,
  start: iso(startMs),
  end: iso(endMs),
  response: "accepted",
});

const ready = (events: DesktopCalendarEvent[]): ActivityCalendarDay => ({
  status: "ready",
  events,
  truncated: false,
});

describe("calendar events beside recorded time", () => {
  test("a recorded call takes the title of the event it overlaps", () => {
    const lane = calendarEventLane({
      day: ready([timed("Hearing prep, Novák", at(10), at(11))]),
      segments: [segment("teams", at(10, 5), at(10, 50), true)],
      dayRange,
    });
    expect(lane.timed).toHaveLength(1);
    expect(lane.timed[0]?.recordedMs).toBe(45 * MINUTE);
    expect(
      callEventTitle({ startMs: at(10, 5), endMs: at(10, 50) }, lane.timed),
    ).toBe("Hearing prep, Novák");
  });

  test("a call names the event it overlaps longest, the earlier on a tie", () => {
    const lane = calendarEventLane({
      day: ready([
        timed("Later", at(11), at(12)),
        timed("Earlier", at(10), at(11)),
        timed("Brief", at(10, 50), at(11, 5)),
      ]),
      segments: [],
      dayRange,
    });
    expect(
      callEventTitle({ startMs: at(10, 30), endMs: at(11, 30) }, lane.timed),
    ).toBe("Earlier");
    expect(
      callEventTitle({ startMs: at(10, 55), endMs: at(11, 40) }, lane.timed),
    ).toBe("Later");
    expect(
      callEventTitle({ startMs: at(13), endMs: at(14) }, lane.timed),
    ).toBeNull();
  });

  test("an untitled event never names a call", () => {
    const lane = calendarEventLane({
      day: ready([timed("", at(10), at(11))]),
      segments: [],
      dayRange,
    });
    expect(
      callEventTitle({ startMs: at(10), endMs: at(11) }, lane.timed),
    ).toBeNull();
  });

  test("time recorded twice, a call beside the app in front, counts once", () => {
    const lane = calendarEventLane({
      day: ready([timed("Client meeting", at(14), at(15))]),
      segments: [
        segment("teams", at(14), at(14, 30), true),
        segment("word", at(14), at(14, 20)),
        segment("word", at(14, 50), at(15, 30)),
      ],
      dayRange,
    });
    expect(lane.timed[0]?.recordedMs).toBe(40 * MINUTE);
  });

  test("an event with nothing recorded keeps its whole time unrecorded", () => {
    const lane = calendarEventLane({
      day: ready([timed("Hearing at the regional court", at(9), at(12))]),
      segments: [segment("word", at(13), at(14))],
      dayRange,
    });
    expect(lane.timed[0]?.recordedMs).toBe(0);
  });

  test("events are cut to the day and those outside it are left out", () => {
    const lane = calendarEventLane({
      day: ready([
        timed("Overnight travel", at(22), dayRange.endMs + 2 * 60 * MINUTE),
        timed("Yesterday", dayRange.startMs - 120 * MINUTE, dayRange.startMs),
      ]),
      segments: [],
      dayRange,
    });
    expect(lane.timed).toHaveLength(1);
    expect(lane.timed[0]?.endMs).toBe(dayRange.endMs);
  });

  test("all-day events stay out of the lane and never name a call", () => {
    const lane = calendarEventLane({
      day: ready([
        { timing: "allDay", title: "Trial in Brno", response: "tentative" },
      ]),
      segments: [segment("teams", at(10), at(11), true)],
      dayRange,
    });
    expect(lane.timed).toEqual([]);
    expect(lane.allDay.map(({ title }) => title)).toEqual(["Trial in Brno"]);
    expect(
      callEventTitle({ startMs: at(10), endMs: at(11) }, lane.timed),
    ).toBeNull();
  });

  test("a day that was not read draws no events", () => {
    for (const day of [
      { status: "off" },
      { status: "turnedOff" },
      { status: "notConnected" },
      { status: "needsReconnect" },
    ] as const) {
      expect(calendarEventLane({ day, segments: [], dayRange })).toEqual({
        timed: [],
        allDay: [],
      });
    }
  });

  test("recorded time inside an event never exceeds the event", () => {
    const minuteOfDay = fc.integer({ min: 0, max: 24 * 60 });
    const range = fc
      .tuple(minuteOfDay, minuteOfDay)
      .map(([left, right]) => ({
        startMs: dayRange.startMs + Math.min(left, right) * MINUTE,
        endMs: dayRange.startMs + Math.max(left, right) * MINUTE,
      }))
      .filter(({ startMs, endMs }) => endMs > startMs);
    assertProperty(
      "activity-calendar.recorded-time-within-event",
      fc.property(
        fc.array(range, { maxLength: 6 }),
        fc.array(fc.tuple(range, fc.boolean()), { maxLength: 12 }),
        (events, recorded) => {
          const lane = calendarEventLane({
            day: ready(
              events.map(({ startMs, endMs }, index) =>
                timed(`Event ${String(index)}`, startMs, endMs),
              ),
            ),
            segments: recorded.map(([{ startMs, endMs }, call]) =>
              segment("app", startMs, endMs, call),
            ),
            dayRange,
          });
          for (const event of lane.timed) {
            expect(event.recordedMs).toBeGreaterThanOrEqual(0);
            expect(event.recordedMs).toBeLessThanOrEqual(
              event.endMs - event.startMs,
            );
            expect(event.startMs).toBeGreaterThanOrEqual(dayRange.startMs);
            expect(event.endMs).toBeLessThanOrEqual(dayRange.endMs);
          }
        },
      ),
    );
  });
});

describe("the native calendar answer", () => {
  test("is checked against the contract before use", () => {
    expect(parseActivityCalendarDay({ status: "off" })).toEqual({
      status: "off",
    });
    expect(
      parseActivityCalendarDay({
        status: "ready",
        truncated: false,
        events: [timed("Hearing", at(9), at(10))],
      })?.status,
    ).toBe("ready");
    for (const malformed of [
      null,
      { status: "unknown" },
      { status: "ready", events: [] },
      {
        status: "ready",
        truncated: false,
        events: [{ ...timed("Board", at(9), at(10)), attendees: [] }],
      },
      {
        status: "ready",
        truncated: false,
        events: [{ ...timed("Board", at(9), at(10)), response: "declined" }],
      },
    ]) {
      expect(parseActivityCalendarDay(malformed)).toBeNull();
    }
  });
});
