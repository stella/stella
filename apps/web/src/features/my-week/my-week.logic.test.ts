import { describe, expect, test } from "bun:test";

import { pendingCountByDay, weekTotals } from "./my-week.logic";

describe("week totals", () => {
  test("sum logged and billable minutes and keep each day's total", () => {
    const totals = weekTotals([
      { dateWorked: "2026-10-26", loggedMinutes: 90, billableMinutes: 60 },
      { dateWorked: "2026-10-28", loggedMinutes: 30, billableMinutes: 0 },
    ]);
    expect(totals.loggedMinutes).toBe(120);
    expect(totals.billableMinutes).toBe(60);
    expect(totals.byDay.get("2026-10-26")).toBe(90);
    expect(totals.byDay.get("2026-10-27")).toBeUndefined();
  });

  test("count pending suggestions across matters per day", () => {
    const counts = pendingCountByDay([
      {
        date: "2026-10-26",
        matters: [{ items: [1, 2] }, { items: [3] }],
      },
    ]);
    expect(counts.get("2026-10-26")).toBe(3);
    expect(counts.get("2026-10-27")).toBeUndefined();
  });
});
