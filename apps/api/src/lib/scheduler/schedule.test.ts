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
});
