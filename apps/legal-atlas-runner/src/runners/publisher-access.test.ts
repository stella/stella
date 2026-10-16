import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";

import { acquirePublisherCycleSlot } from "./publisher-access";

describe("publisher cycle admission", () => {
  test("pauses outside a window and resumes at the next opening without holding a slot", async () => {
    let now = 0;
    let held = false;
    const sleeps: number[] = [];
    const opening = 180_001;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: (_adapterKey, time) =>
        time < opening
          ? { type: "closed", opensAt: opening }
          : { type: "open", closesAt: null },
      now: () => now,
      sleep: async (milliseconds) => {
        expect(held).toBe(false);
        expect(milliseconds).toBeGreaterThan(0);
        expect(milliseconds).toBeLessThanOrEqual(60_000);
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      isDraining: () => false,
      acquire: async () => {
        expect(now).toBe(opening);
        held = true;
      },
      release: () => {
        held = false;
      },
    });
    expect(result).toEqual({ type: "acquired" });
    expect(sleeps.reduce((sum, milliseconds) => sum + milliseconds, 0)).toBe(
      opening,
    );
    expect(held).toBe(true);
  });

  test("rechecks a queued slot and releases it until admission opens again", async () => {
    let now = 0;
    let held = false;
    let acquisitions = 0;
    let releases = 0;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: (_adapterKey, time) =>
        time >= 100 && time < 200
          ? { type: "closed", opensAt: 200 }
          : { type: "open", closesAt: time < 100 ? 100 : null },
      now: () => now,
      sleep: async (milliseconds) => {
        expect(held).toBe(false);
        now += milliseconds;
      },
      isDraining: () => false,
      acquire: async () => {
        acquisitions += 1;
        held = true;
        if (acquisitions === 1) {
          now = 100;
        }
      },
      release: () => {
        releases += 1;
        held = false;
      },
    });
    expect(result).toEqual({ type: "acquired" });
    expect(now).toBe(200);
    expect(acquisitions).toBe(2);
    expect(releases).toBe(1);
  });

  test("draining stops a paused source before a cycle starts", async () => {
    let draining = false;
    let acquisitions = 0;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: () => ({ type: "closed", opensAt: 180_000 }),
      now: () => 0,
      sleep: async () => {
        draining = true;
      },
      isDraining: () => draining,
      acquire: async () => {
        acquisitions += 1;
      },
      release: () => {},
    });
    expect(result).toEqual({ type: "drained" });
    expect(acquisitions).toBe(0);
  });

  test("draining while queued releases the acquired slot without starting", async () => {
    let draining = false;
    let releases = 0;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: () => ({ type: "open", closesAt: null }),
      now: () => 0,
      sleep: async () => {},
      isDraining: () => draining,
      acquire: async () => {
        draining = true;
      },
      release: () => {
        releases += 1;
      },
    });
    expect(result).toEqual({ type: "drained" });
    expect(releases).toBe(1);
  });

  test("a calendar that becomes unavailable while queued releases the slot", async () => {
    let now = 0;
    let releases = 0;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: (_adapterKey, time) =>
        time === 0
          ? { type: "open", closesAt: 1 }
          : { type: "unavailable", reason: "unsupported-calendar-year" },
      now: () => now,
      sleep: async () => {},
      isDraining: () => false,
      acquire: async () => {
        now = 1;
      },
      release: () => {
        releases += 1;
      },
    });
    expect(result).toEqual({
      type: "unavailable",
      reason: "unsupported-calendar-year",
    });
    expect(releases).toBe(1);
  });

  test("an unavailable calendar fails closed without sleeping or acquiring", async () => {
    let sleeps = 0;
    let acquisitions = 0;
    const result = await acquirePublisherCycleSlot({
      adapterKey: ADAPTER_KEYS.AT_COURTS,
      admission: () => ({
        type: "unavailable",
        reason: "unsupported-calendar-year",
      }),
      now: () => 0,
      sleep: async () => {
        sleeps += 1;
      },
      isDraining: () => false,
      acquire: async () => {
        acquisitions += 1;
      },
      release: () => {},
    });
    expect(result).toEqual({
      type: "unavailable",
      reason: "unsupported-calendar-year",
    });
    expect(sleeps).toBe(0);
    expect(acquisitions).toBe(0);
  });
});
