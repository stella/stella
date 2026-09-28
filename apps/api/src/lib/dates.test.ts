import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { parseIsoDateLocal } from "@stll/time";

import {
  addUtcDays,
  canonicalDecisionDate,
  decisionDateMinYear,
  isoCalendarDay,
  toUtcDateString,
} from "./dates";

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

/** The guard as a Czech decision meets it, under the default floor. */
const czechDecisionDate = (raw: string) => canonicalDecisionDate(raw, "CZE");

describe("canonicalDecisionDate", () => {
  test("accepts a bare calendar date unchanged", () => {
    expect(czechDecisionDate("2024-03-05")).toBe("2024-03-05");
  });

  test("takes the date prefix of an ISO datetime", () => {
    expect(czechDecisionDate("2024-03-05T00:00:00Z")).toBe("2024-03-05");
    expect(czechDecisionDate("2024-03-05 00:00:00")).toBe("2024-03-05");
  });

  test("rejects a year below the lower bound", () => {
    expect(czechDecisionDate("0001-01-01")).toBeNull();
    expect(czechDecisionDate("1799-12-31")).toBeNull();
  });

  test("accepts the lower bound itself", () => {
    expect(czechDecisionDate("1800-01-01")).toBe("1800-01-01");
  });

  test("the floor is each jurisdiction's own, 1800 unless it declares another", () => {
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      const floor = decisionDateMinYear(jurisdiction);
      expect([jurisdiction, floor]).toEqual([
        jurisdiction,
        jurisdiction === "USA" ? 1600 : 1800,
      ]);
      expect(
        canonicalDecisionDate(`${String(floor)}-01-01`, jurisdiction),
      ).toBe(`${String(floor)}-01-01`);
      expect(
        canonicalDecisionDate(`${String(floor - 1)}-12-31`, jurisdiction),
      ).toBeNull();
    }
    // A stored code no jurisdiction declares keeps the default floor.
    expect(decisionDateMinYear("ROU")).toBe(1800);
    expect(canonicalDecisionDate("1799-12-31", "ROU")).toBeNull();
    expect(canonicalDecisionDate("1799-12-31", "usa")).toBeNull();
  });

  test("a USA date before 1800 is a date, one before 1600 is not", () => {
    expect(canonicalDecisionDate("1600-01-01", "USA")).toBe("1600-01-01");
    expect(canonicalDecisionDate("1599-12-31", "USA")).toBeNull();
    expect(canonicalDecisionDate("1799-12-31", "USA")).toBe("1799-12-31");
    expect(canonicalDecisionDate("1791-08-03T00:00:00Z", "USA")).toBe(
      "1791-08-03",
    );
    expect(canonicalDecisionDate("1799-12-31", "POL")).toBeNull();
    expect(canonicalDecisionDate("1799-12-31", "EU")).toBeNull();
  });

  test("accepts today and tomorrow (UTC) but not the day after", () => {
    // Pinned just before a UTC midnight: the guard reads its own clock, so
    // an unpinned test could compute the fixture on one day and be judged on
    // the next.
    const now = new Date("2026-03-01T23:59:59.500Z");
    setSystemTime(now);
    try {
      const day = (offset: number) => toUtcDateString(addUtcDays(now, offset));

      expect(czechDecisionDate(day(-1))).toBe("2026-02-28");
      expect(czechDecisionDate(day(0))).toBe("2026-03-01");
      expect(czechDecisionDate(day(1))).toBe("2026-03-02");
      expect(czechDecisionDate(day(2))).toBeNull();
      expect(czechDecisionDate(day(400))).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("rejects a far-future year", () => {
    expect(czechDecisionDate("2944-04-30")).toBeNull();
  });

  test("rejects a day that does not exist on the calendar", () => {
    expect(czechDecisionDate("2024-02-30")).toBeNull();
  });

  test("rejects a value that is not a date at all", () => {
    expect(czechDecisionDate("not-a-date")).toBeNull();
    expect(czechDecisionDate("05.03.2024")).toBeNull();
    expect(czechDecisionDate("2024-03-05X00:00:00")).toBeNull();
    expect(czechDecisionDate("")).toBeNull();
  });

  test("rejects a malformed suffix instead of taking the prefix on faith", () => {
    // A value whose tail is not a time is not a datetime, and its first ten
    // characters are not a date the source stated.
    expect(czechDecisionDate("2024-03-05T")).toBeNull();
    expect(czechDecisionDate("2024-03-05Tgarbage")).toBeNull();
    expect(czechDecisionDate("2024-03-05T25:99:99Z")).toBeNull();
    expect(czechDecisionDate("2024-03-05-extra")).toBeNull();
  });

  test("accepts the datetime forms sources publish", () => {
    expect(czechDecisionDate("2024-03-05T14:30")).toBe("2024-03-05");
    expect(czechDecisionDate("2024-03-05T14:30:59.123Z")).toBe("2024-03-05");
    expect(czechDecisionDate("2024-03-05T14:30:00+02:00")).toBe("2024-03-05");
  });

  test("does not depend on the host timezone's calendar", () => {
    // Samoa crossed the date line at the end of 2011, so 2011-12-30 never
    // happened there in local time. A decision dated that day is still a
    // real record, and ingestion must not accept or reject it based on
    // where the code runs.
    process.env.TZ = "Pacific/Apia";
    expect(parseIsoDateLocal("2011-12-30")).toBeNull();

    expect(czechDecisionDate("2011-12-30")).toBe("2011-12-30");
  });
});

describe("isoCalendarDay", () => {
  test("accepts real calendar years below Date's special 1900 offset", () => {
    expect(isoCalendarDay("0001-01-01")).toBe("0001-01-01");
  });

  test("applies Gregorian leap-year rules independent of the host timezone", () => {
    process.env.TZ = "Pacific/Apia";

    expect(isoCalendarDay("1900-02-29")).toBeNull();
    expect(isoCalendarDay("2000-02-29T23:59:59Z")).toBe("2000-02-29");
    expect(isoCalendarDay("2011-12-30")).toBe("2011-12-30");
  });
});

describe("addUtcDays", () => {
  test("preserves the UTC time while crossing a month boundary", () => {
    const start = new Date("2026-03-31T23:30:00.000Z");

    expect(addUtcDays(start, -30).toISOString()).toBe(
      "2026-03-01T23:30:00.000Z",
    );
  });

  test("walks leap days while preserving the UTC clock and input instant", () => {
    const start = new Date("2024-02-28T06:07:08.009Z");

    expect(addUtcDays(start, 1).toISOString()).toBe("2024-02-29T06:07:08.009Z");
    expect(addUtcDays(start, 2).toISOString()).toBe("2024-03-01T06:07:08.009Z");
    expect(start.toISOString()).toBe("2024-02-28T06:07:08.009Z");
  });

  test("preserves early ISO years when adapting back to Date", () => {
    const start = new Date("0001-12-31T23:59:58.007Z");

    const next = addUtcDays(start, 1);
    expect(toUtcDateString(start)).toBe("0001-12-31");
    expect(toUtcDateString(next)).toBe("0002-01-01");
    expect(next.getUTCHours()).toBe(23);
    expect(next.getUTCMinutes()).toBe(59);
    expect(next.getUTCSeconds()).toBe(58);
    expect(next.getUTCMilliseconds()).toBe(7);
  });
});
