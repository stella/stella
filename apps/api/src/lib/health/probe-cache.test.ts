import { describe, expect, test } from "bun:test";

import { createProbeCache } from "@/api/lib/health/probe-cache";
import type { ProbeOutcome } from "@/api/lib/health/probe-cache";

class TestError extends Error {
  override name = "TestError";
}

const okOutcome: ProbeOutcome<TestError> = { ok: true };

const captureRejection = async <T>(promise: Promise<T>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
};

describe("createProbeCache", () => {
  test("returns the underlying outcome on the first call", async () => {
    let calls = 0;
    const cache = createProbeCache(
      async () => {
        calls++;
        return okOutcome;
      },
      { ttlMs: 1000, now: () => 0 },
    );
    expect(await cache.run()).toEqual(okOutcome);
    expect(calls).toBe(1);
  });

  test("serves repeat calls from cache within the TTL", async () => {
    let calls = 0;
    let clock = 0;
    const cache = createProbeCache(
      async () => {
        calls++;
        return okOutcome;
      },
      { ttlMs: 1000, now: () => clock },
    );
    await cache.run();
    clock = 500;
    await cache.run();
    clock = 999;
    await cache.run();
    expect(calls).toBe(1);
  });

  test("re-runs the probe after the TTL expires", async () => {
    let calls = 0;
    let clock = 0;
    const cache = createProbeCache(
      async () => {
        calls++;
        return okOutcome;
      },
      { ttlMs: 1000, now: () => clock },
    );
    await cache.run();
    clock = 1500;
    await cache.run();
    expect(calls).toBe(2);
  });

  test("coalesces concurrent calls onto a single in-flight probe", async () => {
    let calls = 0;
    let release: () => void = () => {
      // overwritten before any caller awaits the gate
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = createProbeCache(
      async () => {
        calls++;
        await gate;
        return okOutcome;
      },
      { ttlMs: 1000, now: () => 0 },
    );

    const a = cache.run();
    const b = cache.run();
    const c = cache.run();
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b, c]);
    expect(calls).toBe(1);
  });

  test("caches failure outcomes for the TTL window", async () => {
    let calls = 0;
    let clock = 0;
    const failure: ProbeOutcome<TestError> = {
      ok: false,
      error: new TestError("nope"),
    };
    const cache = createProbeCache(
      async () => {
        calls++;
        return failure;
      },
      { ttlMs: 1000, now: () => clock },
    );

    expect(await cache.run()).toBe(failure);
    clock = 100;
    expect(await cache.run()).toBe(failure);
    expect(calls).toBe(1);
    clock = 1500;
    expect(await cache.run()).toBe(failure);
    expect(calls).toBe(2);
  });

  test("releases the in-flight slot when the probe rejects", async () => {
    let calls = 0;
    const cache = createProbeCache<TestError>(
      async () => {
        calls++;
        throw new TestError("boom");
      },
      { ttlMs: 1000, now: () => 0 },
    );
    expect(await captureRejection(cache.run())).toBeInstanceOf(TestError);
    expect(await captureRejection(cache.run())).toBeInstanceOf(TestError);
    expect(calls).toBe(2);
  });
});
