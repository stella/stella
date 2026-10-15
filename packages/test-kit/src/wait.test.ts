import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createTestClock } from "./clock.ts";
import {
  WaitTimeoutError,
  deferred,
  settledWithin,
  waitFor,
  waitForAbort,
  waitForEvent,
} from "./wait.ts";

describe("deferred", () => {
  test("settles once by hand and reports it", async () => {
    const signal = deferred<number>();
    expect(signal.settled()).toBe(false);
    signal.resolve(7);
    expect(signal.settled()).toBe(true);
    expect(await signal.promise).toBe(7);
  });
});

describe("hang guards", () => {
  test("a settled promise wins and clears the guard's sleeper", async () => {
    const clock = createTestClock();
    const value = await settledWithin(Promise.resolve("done"), {
      clock,
      description: "the result",
      timeoutMs: 1000,
    });
    expect(value).toBe("done");
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("a hang fails with what was awaited, on the injected clock", async () => {
    const clock = createTestClock();
    const never = deferred();
    const waiting = settledWithin(never.promise, {
      clock,
      description: "the task to stop",
      timeoutMs: 1000,
    });
    // Handle the rejection before time moves, or it surfaces as unhandled.
    const outcome = waiting.catch((error: unknown) => error);
    await clock.advance(1000);
    const error = await outcome;
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toHaveProperty(
      "message",
      "Timed out after 1000 ms waiting for the task to stop",
    );
  });

  test("a rejection passes through unchanged", async () => {
    const clock = createTestClock();
    const waiting = settledWithin(Promise.reject(new Error("boom")), {
      clock,
      description: "x",
    });
    expect(String(await rejectionOf(waiting))).toContain("boom");
  });
});

describe("event waits", () => {
  test("resolves with the next event and removes its listener", async () => {
    const clock = createTestClock();
    const target = new EventTarget();
    const waiting = waitForEvent(target, "ping", { clock });
    const event = new Event("ping");
    target.dispatchEvent(event);
    expect(await waiting).toBe(event);
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("an abort resolves with its reason, also when it already happened", async () => {
    const clock = createTestClock();
    const controller = new AbortController();
    const waiting = waitForAbort(controller.signal, { clock });
    controller.abort("lease lost");
    expect(await waiting).toBe("lease lost");
    expect(await waitForAbort(controller.signal, { clock })).toBe("lease lost");
  });
});

describe("waitFor", () => {
  test("re-checks on the clock's cadence until the probe yields a value", async () => {
    const clock = createTestClock();
    let probes = 0;
    const waiting = waitFor(
      () => {
        probes += 1;
        return probes === 3 ? "ready" : undefined;
      },
      { clock, description: "the row", intervalMs: 50 },
    );
    await clock.advance(100);
    expect(await waiting).toBe("ready");
    expect(probes).toBe(3);
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("a throwing probe fails the wait at once", async () => {
    const clock = createTestClock();
    const waiting = waitFor(
      () => {
        throw new Error("bad state");
      },
      { clock, description: "x" },
    );
    expect(String(await rejectionOf(waiting))).toContain("bad state");
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("gives up after the hang guard and stops probing", async () => {
    const clock = createTestClock();
    let probes = 0;
    const waiting = waitFor(
      () => {
        probes += 1;
        return undefined;
      },
      { clock, description: "a value", intervalMs: 100, timeoutMs: 1000 },
    );
    const outcome = waiting.catch((error: unknown) => error);
    await clock.advance(1000);
    expect(await outcome).toBeInstanceOf(WaitTimeoutError);
    const probesAtTimeout = probes;
    await clock.advance(1000);
    expect(probes).toBe(probesAtTimeout);
  });

  test("a probe that never settles still hits the hang guard", async () => {
    const clock = createTestClock();
    const stuck = deferred<string | undefined>();
    let probes = 0;
    const waiting = waitFor(
      async () => {
        probes += 1;
        return stuck.promise;
      },
      { clock, description: "a stuck probe", timeoutMs: 500 },
    );
    const outcome = waiting.catch((error: unknown) => error);
    await clock.advance(500);
    expect(await outcome).toBeInstanceOf(WaitTimeoutError);
    // A late answer after the deadline is ignored and polling has stopped.
    stuck.resolve(undefined);
    await clock.advance(1000);
    expect(probes).toBe(1);
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("a probe failing after the deadline is not reported again", async () => {
    const clock = createTestClock();
    const stuck = deferred<string | undefined>();
    const waiting = waitFor(async () => stuck.promise, {
      clock,
      description: "a late failure",
      timeoutMs: 100,
    });
    const outcome = waiting.catch((error: unknown) => error);
    await clock.advance(100);
    expect(await outcome).toBeInstanceOf(WaitTimeoutError);
    // An unhandled rejection here would fail this test in the runner.
    stuck.reject(new Error("late"));
    await clock.advance(10);
    expect(await outcome).toBeInstanceOf(WaitTimeoutError);
  });

  test("refuses a non-positive interval", async () => {
    expect(
      String(
        await rejectionOf(
          waitFor(() => 1, { description: "x", intervalMs: 0 }),
        ),
      ),
    ).toContain("positive");
  });
});
