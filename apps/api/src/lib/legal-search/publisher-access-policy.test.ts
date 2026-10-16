import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  AUSTRIAN_NATIONAL_HOLIDAYS,
  evaluatePublisherAccessPolicy,
} from "./publisher-access-policy";

const POLICY = { type: "scheduled", schedule: "austrian-off-hours" } as const;
const vienna = (localDateTime: string) =>
  Temporal.ZonedDateTime.from(`${localDateTime}[Europe/Vienna]`)
    .epochMilliseconds;

const evaluation = (localDateTime: string) =>
  evaluatePublisherAccessPolicy(POLICY, vienna(localDateTime));

describe("publisher access follows Austrian local time", () => {
  test("an unrestricted publisher has no closing boundary", () => {
    expect(evaluatePublisherAccessPolicy({ type: "unrestricted" }, 0)).toEqual({
      type: "open",
      closesAt: null,
    });
  });

  test.each([
    [
      "2026-10-20T04:59:59.999",
      { type: "open", closesAt: vienna("2026-10-20T05:00") },
    ],
    [
      "2026-10-20T05:00",
      { type: "closed", opensAt: vienna("2026-10-20T20:00") },
    ],
    [
      "2026-10-20T19:59:59.999",
      { type: "closed", opensAt: vienna("2026-10-20T20:00") },
    ],
    [
      "2026-10-20T20:00",
      { type: "open", closesAt: vienna("2026-10-21T05:00") },
    ],
    [
      "2026-10-21T00:00",
      { type: "open", closesAt: vienna("2026-10-21T05:00") },
    ],
  ])(
    "%s observes inclusive opening and exclusive closing",
    (local, expected) => {
      expect(evaluation(local)).toEqual(expected);
    },
  );

  test.each([
    ["2026-10-16T20:00", "2026-10-19T05:00"],
    ["2026-10-17T12:00", "2026-10-19T05:00"],
    ["2026-10-18T12:00", "2026-10-19T05:00"],
    ["2026-10-23T20:00", "2026-10-27T05:00"],
    ["2026-12-24T20:00", "2026-12-28T05:00"],
    ["2026-12-25T12:00", "2026-12-28T05:00"],
    ["2026-04-03T20:00", "2026-04-07T05:00"],
  ])(
    "%s stays continuously open through weekends and holidays",
    (local, closes) => {
      expect(evaluation(local)).toEqual({
        type: "open",
        closesAt: vienna(closes),
      });
    },
  );

  test.each([
    ["2026-03-27T20:00", "2026-03-30T05:00", 56],
    ["2026-10-23T20:00", "2026-10-27T05:00", 82],
  ])(
    "%s uses calendar boundaries through DST",
    (start, close, elapsedHours) => {
      const from = vienna(start);
      const until = vienna(close);
      expect(until - from).toBe(elapsedHours * 60 * 60 * 1000);
      expect(evaluatePublisherAccessPolicy(POLICY, from)).toEqual({
        type: "open",
        closesAt: until,
      });
    },
  );

  test("both repeated autumn hours and the spring jump stay inside the window", () => {
    for (const instant of [
      "2026-10-25T02:30+02:00[Europe/Vienna]",
      "2026-10-25T02:30+01:00[Europe/Vienna]",
    ]) {
      expect(
        evaluatePublisherAccessPolicy(
          POLICY,
          Temporal.ZonedDateTime.from(instant).epochMilliseconds,
        ),
      ).toEqual({ type: "open", closesAt: vienna("2026-10-27T05:00") });
    }
    expect(evaluation("2026-03-29T03:00")).toEqual({
      type: "open",
      closesAt: vienna("2026-03-30T05:00"),
    });
  });

  test("every dated national holiday opens the full day in every supported year", () => {
    for (const [year, dates] of Object.entries(AUSTRIAN_NATIONAL_HOLIDAYS)) {
      expect(dates).toHaveLength(13);
      expect(new Set(dates).size).toBe(13);
      for (const date of dates) {
        expect(Temporal.PlainDate.from(date).year).toBe(Number(year));
        for (const time of ["00:00", "05:00", "12:00", "19:59", "23:59"]) {
          expect(evaluation(`${date}T${time}`).type).toBe("open");
        }
      }
    }
  });

  test("a daytime caller receives the next actual opening", () => {
    const opensAt = vienna("2026-10-23T20:00");
    expect(evaluation("2026-10-23T12:00")).toEqual({ type: "closed", opensAt });
    expect(evaluatePublisherAccessPolicy(POLICY, opensAt - 1).type).toBe(
      "closed",
    );
    expect(evaluatePublisherAccessPolicy(POLICY, opensAt).type).toBe("open");
  });

  test.each(["2025-12-27T12:00", "2032-01-01T00:00", "2040-01-07T22:00"])(
    "%s fails closed even if a weekend, holiday or night would otherwise open",
    (local) => {
      expect(evaluation(local)).toEqual({
        type: "unavailable",
        reason: "unsupported-calendar-year",
      });
    },
  );

  test("the last supported evening closes at the unknown year's midnight", () => {
    expect(evaluation("2031-12-31T20:00")).toEqual({
      type: "open",
      closesAt: vienna("2032-01-01T00:00"),
    });
  });

  test("the calendar covers the current Vienna year", () => {
    const year = Temporal.Now.zonedDateTimeISO("Europe/Vienna").year;
    expect(Object.hasOwn(AUSTRIAN_NATIONAL_HOLIDAYS, year)).toBe(true);
  });
});
