import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { parseIsoDateLocal } from "@stll/time";

import { addUtcDays, canonicalDecisionDate, toUtcDateString } from "./dates";

// Date's local-time methods read `process.env.TZ` on every call in Bun (and
// Node), so flipping it around a test reproduces the exact footgun in a
// deterministic CI environment instead of depending on the runner's host TZ.
//
// Always REASSIGN, never `delete process.env["TZ"]`: deleting the key mid
// process poisons Bun's cached local-time resolver for the rest of the
// process (every later Date falls back to UTC, even after a fresh
// assignment) — reassigning to `""` restores the same "no override"
// behavior without tripping that cache bug.
let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  process.env.TZ = originalTz ?? "";
});

describe("canonicalDecisionDate", () => {
  test("accepts a bare calendar date unchanged", () => {
    expect(canonicalDecisionDate("2024-03-05")).toBe("2024-03-05");
  });

  test("takes the date prefix of an ISO datetime", () => {
    expect(canonicalDecisionDate("2024-03-05T00:00:00Z")).toBe("2024-03-05");
    expect(canonicalDecisionDate("2024-03-05 00:00:00")).toBe("2024-03-05");
  });

  test("rejects a year below the lower bound", () => {
    expect(canonicalDecisionDate("0001-01-01")).toBeNull();
    expect(canonicalDecisionDate("1799-12-31")).toBeNull();
  });

  test("accepts the lower bound itself", () => {
    expect(canonicalDecisionDate("1800-01-01")).toBe("1800-01-01");
  });

  test("accepts today and tomorrow (UTC) but not the day after", () => {
    // Pinned just before a UTC midnight: the guard reads its own clock, so
    // an unpinned test could compute the fixture on one day and be judged on
    // the next.
    const now = new Date("2026-03-01T23:59:59.500Z");
    setSystemTime(now);
    try {
      const day = (offset: number) => toUtcDateString(addUtcDays(now, offset));

      expect(canonicalDecisionDate(day(-1))).toBe("2026-02-28");
      expect(canonicalDecisionDate(day(0))).toBe("2026-03-01");
      expect(canonicalDecisionDate(day(1))).toBe("2026-03-02");
      expect(canonicalDecisionDate(day(2))).toBeNull();
      expect(canonicalDecisionDate(day(400))).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("rejects a far-future year", () => {
    expect(canonicalDecisionDate("2944-04-30")).toBeNull();
  });

  test("rejects a day that does not exist on the calendar", () => {
    expect(canonicalDecisionDate("2024-02-30")).toBeNull();
  });

  test("rejects a value that is not a date at all", () => {
    expect(canonicalDecisionDate("not-a-date")).toBeNull();
    expect(canonicalDecisionDate("05.03.2024")).toBeNull();
    expect(canonicalDecisionDate("2024-03-05X00:00:00")).toBeNull();
    expect(canonicalDecisionDate("")).toBeNull();
  });

  test("rejects a malformed suffix instead of taking the prefix on faith", () => {
    // A value whose tail is not a time is not a datetime, and its first ten
    // characters are not a date the source stated.
    expect(canonicalDecisionDate("2024-03-05T")).toBeNull();
    expect(canonicalDecisionDate("2024-03-05Tgarbage")).toBeNull();
    expect(canonicalDecisionDate("2024-03-05T25:99:99Z")).toBeNull();
    expect(canonicalDecisionDate("2024-03-05-extra")).toBeNull();
  });

  test("accepts the datetime forms sources publish", () => {
    expect(canonicalDecisionDate("2024-03-05T14:30")).toBe("2024-03-05");
    expect(canonicalDecisionDate("2024-03-05T14:30:59.123Z")).toBe(
      "2024-03-05",
    );
    expect(canonicalDecisionDate("2024-03-05T14:30:00+02:00")).toBe(
      "2024-03-05",
    );
  });

  test("does not depend on the host timezone's calendar", () => {
    // Samoa crossed the date line at the end of 2011, so 2011-12-30 never
    // happened there in local time. A decision dated that day is still a
    // real record, and ingestion must not accept or reject it based on
    // where the code runs.
    process.env.TZ = "Pacific/Apia";
    expect(parseIsoDateLocal("2011-12-30")).toBeNull();

    expect(canonicalDecisionDate("2011-12-30")).toBe("2011-12-30");
  });
});

describe("addUtcDays", () => {
  test("preserves the UTC time while crossing a month boundary", () => {
    const start = new Date("2026-03-31T23:30:00.000Z");

    expect(addUtcDays(start, -30).toISOString()).toBe(
      "2026-03-01T23:30:00.000Z",
    );
  });
});
