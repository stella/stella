import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import contract from "../fixtures/activity-contract.json" with { type: "json" };
import {
  BLOCK_GAP_MS,
  appTotals,
  proposeBlocks,
  roundedTenthsOfHour,
  shiftDate,
  timedSegments,
  topAppNames,
  totalDurationMs,
} from "../src/activity/activity-logic";
import {
  ACTIVITY_CHANGED_EVENT,
  ACTIVITY_RECORDING_STATUSES,
  ACTIVITY_RETENTIONS,
  isActivityDaySnapshot,
} from "../src/activity/activity-types";

const MINUTE = 60_000;
const BASE_INSTANT = Temporal.Instant.from("2026-03-10T08:00:00Z");
const BASE = BASE_INSTANT.epochMilliseconds;

const at = (minute: number) => BASE_INSTANT.add({ minutes: minute }).toString();

const segment = (app: string, startMinute: number, endMinute: number) => ({
  appIdentifier: app,
  appName: app.toUpperCase(),
  end: at(endMinute),
  start: at(startMinute),
});

describe("activity contract", () => {
  test("the frontend lists the values the native side serializes", () => {
    expect(contract.retentions).toEqual([...ACTIVITY_RETENTIONS]);
    expect(contract.recordingStatuses).toEqual([
      ...ACTIVITY_RECORDING_STATUSES,
    ]);
    expect(contract.changedEvent).toBe(ACTIVITY_CHANGED_EVENT);
  });

  test("a snapshot is validated before use", () => {
    const snapshot = {
      date: "2026-03-10",
      earliestDate: "2026-02-09",
      excludedApps: [{ identifier: "com.example.app", name: "App" }],
      persistence: "encrypted",
      recordingStatus: "recording",
      retention: "month",
      segments: [segment("word", 0, 5)],
      today: "2026-03-10",
      unreadable: false,
    };
    expect(isActivityDaySnapshot(snapshot)).toBe(true);
    expect(isActivityDaySnapshot({ ...snapshot, retention: "year" })).toBe(
      false,
    );
    expect(
      isActivityDaySnapshot({ ...snapshot, segments: [{ appName: "x" }] }),
    ).toBe(false);
  });
});

describe("activity day logic", () => {
  test("segments are parsed, ordered and empty ones dropped", () => {
    const segments = timedSegments([
      segment("mail", 30, 40),
      segment("word", 0, 10),
      segment("empty", 50, 50),
    ]);
    expect(segments.map((item) => item.appIdentifier)).toEqual([
      "word",
      "mail",
    ]);
    expect(totalDurationMs(segments)).toBe(20 * MINUTE);
  });

  test("app totals add up per app, longest first", () => {
    const totals = appTotals(
      timedSegments([
        segment("word", 0, 10),
        segment("mail", 10, 35),
        segment("word", 35, 40),
      ]),
    );
    expect(totals).toEqual([
      { durationMs: 25 * MINUTE, identifier: "mail", name: "MAIL" },
      { durationMs: 15 * MINUTE, identifier: "word", name: "WORD" },
    ]);
  });

  test("blocks merge across gaps shorter than ten minutes", () => {
    const blocks = proposeBlocks(
      timedSegments([
        segment("word", 0, 20),
        segment("mail", 29, 40),
        // Exactly ten minutes after the previous end: a new block.
        segment("word", 50, 61),
      ]),
    );
    expect(BLOCK_GAP_MS).toBe(10 * MINUTE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startMs).toBe(BASE);
    expect(blocks[0]?.endMs).toBe(BASE + 40 * MINUTE);
    // 40 minutes round up to 42: 0.7 h.
    expect(blocks[0]?.roundedTenths).toBe(7);
    expect(blocks[1]?.roundedTenths).toBe(2);
    expect(blocks[0] && topAppNames(blocks[0])).toEqual(["WORD", "MAIL"]);
  });

  test("durations round up to whole six-minute increments", () => {
    expect(roundedTenthsOfHour(0)).toBe(0);
    expect(roundedTenthsOfHour(1)).toBe(1);
    expect(roundedTenthsOfHour(6 * MINUTE)).toBe(1);
    expect(roundedTenthsOfHour(6 * MINUTE + 1)).toBe(2);
    for (let minutes = 1; minutes <= 600; minutes += 1) {
      const tenths = roundedTenthsOfHour(minutes * MINUTE);
      expect(tenths * 6).toBeGreaterThanOrEqual(minutes);
      expect((tenths - 1) * 6).toBeLessThan(minutes);
    }
  });

  test("calendar dates shift across month and year boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
  });
});
