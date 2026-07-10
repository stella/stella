import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addDays, isIsoDateString, parseIsoDateLocal } from "./dates";

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

describe("isIsoDateString", () => {
  test("accepts YYYY-MM-DD", () => {
    expect(isIsoDateString("2024-01-01")).toBe(true);
  });

  test("rejects non-ISO shapes", () => {
    expect(isIsoDateString("01/01/2024")).toBe(false);
    expect(isIsoDateString("2024-1-1")).toBe(false);
    expect(isIsoDateString("2024-01-01T00:00:00Z")).toBe(false);
    expect(isIsoDateString("")).toBe(false);
  });
});

describe("parseIsoDateLocal", () => {
  test("does not shift a day west of UTC (the new Date(string) bug)", () => {
    process.env.TZ = "Pacific/Honolulu"; // UTC-10, west of UTC

    // The footgun this guards against: `new Date("2024-01-01")` parses as
    // UTC midnight, which renders as Dec 31 in a west-of-UTC timezone.
    expect(new Date("2024-01-01").getDate()).toBe(31);

    // `parseIsoDateLocal` must land on the intended calendar day instead.
    const parsed = parseIsoDateLocal("2024-01-01");
    expect(parsed?.getFullYear()).toBe(2024);
    expect(parsed?.getMonth()).toBe(0);
    expect(parsed?.getDate()).toBe(1);
  });

  test("lands on the intended day east of UTC too", () => {
    process.env.TZ = "Pacific/Auckland"; // UTC+12/+13

    const parsed = parseIsoDateLocal("2024-06-15");
    expect(parsed?.getFullYear()).toBe(2024);
    expect(parsed?.getMonth()).toBe(5);
    expect(parsed?.getDate()).toBe(15);
  });

  test("rejects a calendar date that does not exist", () => {
    expect(parseIsoDateLocal("2024-02-30")).toBeNull();
    expect(parseIsoDateLocal("2024-13-01")).toBeNull();
    expect(parseIsoDateLocal("2024-00-10")).toBeNull();
  });

  test("rejects malformed strings", () => {
    expect(parseIsoDateLocal("not-a-date")).toBeNull();
    expect(parseIsoDateLocal("2024-01-01T00:00:00Z")).toBeNull();
    expect(parseIsoDateLocal("")).toBeNull();
  });
});

describe("addDays", () => {
  test("crosses a spring-forward DST transition without overshooting", () => {
    process.env.TZ = "America/New_York";
    // 2024-03-10 02:00 -> 03:00: the 10th is a 23-hour day.
    const start = new Date(2024, 2, 9, 12, 0, 0);

    // The footgun this guards against: a fixed 24h millisecond step
    // overshoots the wall clock on a 23-hour day.
    const naive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    expect(naive.getDate()).toBe(10);
    expect(naive.getHours()).toBe(13); // overshot noon by an hour

    const next = addDays(start, 1);
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(12); // stays on the intended wall-clock hour
  });

  test("crosses a fall-back DST transition without undershooting", () => {
    process.env.TZ = "America/New_York";
    // 2024-11-03 02:00 -> 01:00: the 3rd is a 25-hour day.
    const start = new Date(2024, 10, 2, 12, 0, 0);

    const naive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    expect(naive.getDate()).toBe(3);
    expect(naive.getHours()).toBe(11); // undershot noon by an hour

    const next = addDays(start, 1);
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(12);
  });

  test("rolls over a month/year boundary", () => {
    // Read back via local getters (not `toISOString`, which reprojects
    // through UTC and would make this assertion depend on the host TZ).
    const next = addDays(new Date(2024, 11, 31), 1);
    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(1);
  });

  test("subtracts with a negative n", () => {
    const prev = addDays(new Date(2024, 0, 1), -1);
    expect(prev.getFullYear()).toBe(2023);
    expect(prev.getMonth()).toBe(11);
    expect(prev.getDate()).toBe(31);
  });
});
