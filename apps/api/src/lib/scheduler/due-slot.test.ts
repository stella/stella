import { describe, expect, test } from "bun:test";

import { DueSlot } from "@/api/lib/scheduler/due-slot";

const days = (slot: DueSlot, zone: string): string[] =>
  slot.elapsedDailySlotDaysIn(zone).map((day) => day.toString());

describe("DueSlot", () => {
  test("an on-time claim covers only its own slot", () => {
    const slot = DueSlot.of({
      nextRunAt: new Date("2026-07-06T09:00:00.000Z"),
      lockedAt: new Date("2026-07-06T09:00:05.000Z"),
    });
    expect(days(slot, "UTC")).toEqual(["2026-07-06"]);
    expect(slot.claimedAtDate()).toEqual(new Date("2026-07-06T09:00:05.000Z"));
  });

  test("a backlogged claim covers every later slot that had elapsed", () => {
    const slot = DueSlot.of({
      nextRunAt: new Date("2026-07-04T09:00:00.000Z"),
      lockedAt: new Date("2026-07-06T09:00:00.000Z"),
    });
    expect(days(slot, "UTC")).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
    ]);
  });

  test("later slots keep their wall time across a daylight-saving change", () => {
    // Europe/Prague moves to CEST on 2026-03-29; 09:00 local is 08:00Z then 07:00Z.
    const slot = DueSlot.of({
      nextRunAt: new Date("2026-03-28T08:00:00.000Z"),
      lockedAt: new Date("2026-03-29T07:30:00.000Z"),
    });
    expect(days(slot, "Europe/Prague")).toEqual(["2026-03-28", "2026-03-29"]);
  });

  test("a row without a claim instant covers its slot alone", () => {
    const slot = DueSlot.of({
      nextRunAt: new Date("2026-07-06T09:00:00.000Z"),
      lockedAt: null,
    });
    expect(days(slot, "UTC")).toEqual(["2026-07-06"]);
    expect(slot.claimedAtDate()).toEqual(new Date("2026-07-06T09:00:00.000Z"));
  });

  test("a claim instant before the slot is clamped to the slot", () => {
    const slot = DueSlot.of({
      nextRunAt: new Date("2026-07-06T09:00:00.000Z"),
      lockedAt: new Date("2026-07-06T08:00:00.000Z"),
    });
    expect(days(slot, "UTC")).toEqual(["2026-07-06"]);
    expect(slot.claimedAtDate()).toEqual(new Date("2026-07-06T09:00:00.000Z"));
  });
});
