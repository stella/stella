import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { timedSegments } from "../src/activity/activity-logic";
import { unrecordedRanges } from "../src/activity/activity-unrecorded";

const BASE_INSTANT = Temporal.Instant.from("2026-03-10T08:00:00Z");
const at = (minute: number) => BASE_INSTANT.add({ minutes: minute }).toString();
const ms = (minute: number) =>
  BASE_INSTANT.add({ minutes: minute }).epochMilliseconds;

const segment = (app: string, startMinute: number, endMinute: number) => ({
  appIdentifier: app,
  appName: app.toUpperCase(),
  start: at(startMinute),
  end: at(endMinute),
});

describe("unrecorded ranges", () => {
  test("a gap is named by the segment that ended where it began", () => {
    const segments = timedSegments([
      segment("word", 0, 10),
      segment("mail", 30, 40),
    ]);
    const ranges = unrecordedRanges(
      [],
      [
        { start: at(40), end: at(55), endedBy: "stop", display: "locked" },
        { start: at(10), end: at(30), endedBy: "input", display: "stayedOn" },
      ],
      segments,
    );
    expect(ranges).toEqual([
      {
        type: "gap",
        after: segments[0] ?? null,
        display: "stayedOn",
        endMs: ms(30),
        endedBy: "input",
        startMs: ms(10),
      },
      {
        type: "gap",
        after: segments[1] ?? null,
        display: "locked",
        endMs: ms(55),
        endedBy: "stop",
        startMs: ms(40),
      },
    ]);
  });

  test("a gap after no recorded segment names nothing", () => {
    const ranges = unrecordedRanges(
      [],
      [{ start: at(70), end: at(80), endedBy: "input", display: "slept" }],
      timedSegments([segment("word", 0, 10)]),
    );
    expect(ranges).toEqual([
      {
        type: "gap",
        after: null,
        display: "slept",
        endMs: ms(80),
        endedBy: "input",
        startMs: ms(70),
      },
    ]);
  });

  test("outages and gaps are one list", () => {
    const ranges = unrecordedRanges(
      [{ startMs: ms(0), endMs: ms(20), reason: "reconnectNeeded" }],
      [{ start: at(40), end: at(50), endedBy: "input", display: "stayedOn" }],
      [],
    );
    expect(ranges.map(({ type }) => type)).toEqual(["outage", "gap"]);
  });
});
