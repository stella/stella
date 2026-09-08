import { describe, expect, test } from "bun:test";

import { computeNextRunAt } from "@/api/lib/scheduler/schedule";

describe("computeNextRunAt", () => {
  test("computes interval schedules from the provided instant", () => {
    const nextRunAt = computeNextRunAt(
      { type: "interval", everyMs: 5 * 60_000 },
      new Date("2026-04-29T10:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-04-29T10:05:00.000Z");
  });

  test.each([0, -120_001, 1_800_000_000_000])(
    "preserves millisecond clipping for fractional intervals from %s",
    (epochMilliseconds) => {
      const interval = 60_000.5;
      const next = computeNextRunAt(
        { type: "interval", everyMs: interval },
        new Date(epochMilliseconds),
      );
      expect(next.getTime()).toBe(
        new Date(epochMilliseconds + interval).getTime(),
      );
    },
  );

  test("uses today's daily occurrence when it is still in the future", () => {
    const nextRunAt = computeNextRunAt(
      { type: "daily", hour: 2, minute: 30, timeZone: "UTC" },
      new Date("2026-04-29T01:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-04-29T02:30:00.000Z");
  });

  test("uses tomorrow's daily occurrence after today's time has passed", () => {
    const nextRunAt = computeNextRunAt(
      { type: "daily", hour: 2, minute: 30, timeZone: "UTC" },
      new Date("2026-04-29T03:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-04-30T02:30:00.000Z");
  });

  test("computes daily schedules in the configured time zone", () => {
    const nextRunAt = computeNextRunAt(
      { type: "daily", hour: 2, minute: 30, timeZone: "Europe/Prague" },
      new Date("2026-04-29T00:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-04-29T00:30:00.000Z");
  });

  test("rolls a spring-forward non-existent time forward instead of skipping it", () => {
    // Europe/Prague 2026-03-29: 02:00 -> 03:00 local (01:00Z), so 02:30
    // local does not exist. The run must still fire, rolled forward to the
    // next valid instant (03:30 local = 01:30Z), not dropped.
    const nextRunAt = computeNextRunAt(
      { type: "daily", hour: 2, minute: 30, timeZone: "Europe/Prague" },
      new Date("2026-03-29T00:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  test("resolves a fall-back ambiguous time to its first occurrence", () => {
    // Europe/Prague 2026-10-25: 03:00 -> 02:00 local (01:00Z), so 02:30
    // local occurs twice. Take the first (CEST, 00:30Z), never both.
    const nextRunAt = computeNextRunAt(
      { type: "daily", hour: 2, minute: 30, timeZone: "Europe/Prague" },
      new Date("2026-10-25T00:00:00.000Z"),
    );

    expect(nextRunAt.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test.each([
    ["2026-03-29T02:00:00.000Z", "2026-03-30T00:30:00.000Z"],
    ["2026-10-25T00:45:00.000Z", "2026-10-26T01:30:00.000Z"],
    ["2026-04-29T00:30:00.000Z", "2026-04-30T00:30:00.000Z"],
  ])(
    "daily schedules advance past an occurrence at %s without running it twice",
    (from, expected) => {
      const input = new Date(from);
      const result = computeNextRunAt(
        { type: "daily", hour: 2, minute: 30, timeZone: "Europe/Prague" },
        input,
      );
      expect(result.toISOString()).toBe(expected);
      expect(input.toISOString()).toBe(from);
    },
  );
});
