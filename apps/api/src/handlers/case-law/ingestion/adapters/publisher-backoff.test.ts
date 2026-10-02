import { describe, expect, test } from "bun:test";

import { createPublisherRequestSlot } from "./publisher-request-gate";

const createGateClock = () => {
  let now = 0;
  const values = new Map<string, number>();
  const waiting: { until: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];
  const redis = {
    send: (_command: string, args: string[]) => {
      const keyCount = Number(args.at(1));
      const key = args.at(2);
      if (key === undefined) {
        throw new Error("Gate command has no key");
      }
      // Model Redis replies against a shared clock to exercise scheduling; this fake does not execute Lua.
      if (key.endsWith(":cooldown")) {
        const duration = args.at(3);
        const until = Math.max(
          values.get(key) ?? now,
          duration === undefined ? now : now + Number(duration),
        );
        values.set(key, until);
        return Math.max(0, until - now);
      }
      const cooldownKey = keyCount === 2 ? args.at(3) : undefined;
      const slot = Math.max(
        now,
        values.get(key) ?? now,
        cooldownKey === undefined ? now : (values.get(cooldownKey) ?? now),
      );
      values.set(key, slot + Number(args.at(2 + keyCount)));
      return slot - now;
    },
  };
  const dependencies = {
    redis: () => redis,
    sleep: async (durationMs: number) => {
      sleeps.push(durationMs);
      if (durationMs === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        waiting.push({ until: now + durationMs, resolve });
      });
    },
  };
  return {
    dependencies,
    sleeps,
    advanceTo: (time: number) => {
      now = time;
      for (const sleeper of waiting.splice(0)) {
        if (sleeper.until <= now) {
          sleeper.resolve();
        } else {
          waiting.push(sleeper);
        }
      }
    },
  };
};

const settleMicrotasks = async () => {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
};

const CONFIG = {
  intervalMs: 500,
  key: "case-law:publisher-gate:cellar-eu",
  publisher: "EU Cellar",
  cooldown: "shared",
} as const;

describe("a publisher cooldown shared across workers", () => {
  test("a second eu-ecj request cannot pass the gate during backoff", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker();
    await firstWorker.defer(2000);

    let requested = false;
    const secondRequest = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([0, 2000]);
    expect(requested).toBe(false);
    clock.advanceTo(1999);
    await settleMicrotasks();
    expect(requested).toBe(false);
    clock.advanceTo(2000);
    await secondRequest;
    expect(requested).toBe(true);
  });

  test("an already reserved request rechecks a cooldown announced while it sleeps", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker();
    let requested = false;
    const queuedRequest = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([0, 500]);
    await firstWorker.defer(2000);
    clock.advanceTo(500);
    await settleMicrotasks();
    expect(requested).toBe(false);
    expect(clock.sleeps).toEqual([0, 500, 1500]);
    clock.advanceTo(2000);
    await queuedRequest;
    expect(requested).toBe(true);
  });

  test("a shorter backoff cannot shorten an existing shared cooldown", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker.defer(5000);
    await secondWorker.defer(1000);
    let requested = false;
    const pending = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([5000]);
    clock.advanceTo(1000);
    await settleMicrotasks();
    expect(requested).toBe(false);
    clock.advanceTo(5000);
    await pending;
    expect(requested).toBe(true);
  });
});
