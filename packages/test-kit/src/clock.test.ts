import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { TEST_CLOCK_START, createTestClock } from "./clock.ts";

describe("test clock", () => {
  test("starts at a fixed instant and only moves when advanced", async () => {
    const clock = createTestClock();
    expect(clock.now()).toBe(TEST_CLOCK_START);
    expect(clock.monotonic()).toBe(0);
    await clock.advance(1500);
    expect(clock.now()).toBe(TEST_CLOCK_START + 1500);
    expect(clock.monotonic()).toBe(1500);
  });

  test("a sleeper wakes exactly when its duration has passed", async () => {
    const clock = createTestClock();
    let woke = false;
    const sleeping = (async () => {
      await clock.sleep(100);
      woke = true;
    })();
    await clock.advance(99);
    expect(woke).toBe(false);
    await clock.advance(1);
    await sleeping;
    expect(woke).toBe(true);
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("sleepers wake in deadline order, ties in the order they slept", async () => {
    const clock = createTestClock();
    const order: string[] = [];
    const sleep = async (name: string, ms: number) =>
      clock.sleep(ms).then(() => order.push(`${name}@${clock.monotonic()}`));
    const all = Promise.all([
      sleep("c", 30),
      sleep("a", 10),
      sleep("b", 10),
      sleep("z", 0),
    ]);
    await clock.advance(30);
    await all;
    expect(order).toEqual(["z@0", "a@10", "b@10", "c@30"]);
  });

  test("work a woken sleeper schedules runs within the same advance", async () => {
    const clock = createTestClock();
    const ticks: number[] = [];
    const loop = async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await clock.sleep(100);
        ticks.push(clock.monotonic());
      }
    };
    const running = loop();
    await clock.advance(350);
    expect(ticks).toEqual([100, 200, 300]);
    await clock.advance(1000);
    await running;
    expect(ticks).toEqual([100, 200, 300, 400, 500]);
  });

  test("advanceToNext jumps to the earliest sleeper and reports when none is left", async () => {
    const clock = createTestClock();
    const sleeping = clock.sleep(250);
    expect(await clock.advanceToNext()).toBe(true);
    await sleeping;
    expect(clock.monotonic()).toBe(250);
    expect(await clock.advanceToNext()).toBe(false);
  });

  test("an aborted sleep rejects with the abort reason and stops counting", async () => {
    const clock = createTestClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(100, { signal: controller.signal });
    expect(clock.pendingSleepers()).toBe(1);
    controller.abort(new Error("stopped"));
    expect(String(await rejectionOf(sleeping))).toContain("stopped");
    expect(clock.pendingSleepers()).toBe(0);
    const already = clock.sleep(1, { signal: controller.signal });
    expect(String(await rejectionOf(already))).toContain("stopped");
  });

  test("setTime moves wall time without moving monotonic time", async () => {
    const clock = createTestClock({ start: 0 });
    clock.setTime(1_000_000);
    expect(clock.now()).toBe(1_000_000);
    expect(clock.monotonic()).toBe(0);
    await clock.advance(5);
    expect(clock.now()).toBe(1_000_005);
  });

  test("refuses negative and non-finite durations", async () => {
    const clock = createTestClock();
    expect(String(await rejectionOf(clock.sleep(-1)))).toContain(
      "non-negative",
    );
    expect(String(await rejectionOf(clock.advance(Number.NaN)))).toContain(
      "non-negative",
    );
    expect(() => clock.setTime(Number.POSITIVE_INFINITY)).toThrow("finite");
  });

  test("overlapping advances are a test bug", async () => {
    const clock = createTestClock();
    const first = clock.advance(10);
    expect(String(await rejectionOf(clock.advance(10)))).toContain(
      "already running",
    );
    await first;
  });
});
