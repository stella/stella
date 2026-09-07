import { describe, expect, test } from "bun:test";

import { watchForDesktopBridge } from "@/features/desktop/desktop-bridge-watch.logic";

/** Scripted probe: answers from the queue, then keeps answering false. */
const scriptedProbe = (answers: readonly boolean[]) => {
  const signals: AbortSignal[] = [];
  return {
    calls: signals,
    probe: async (signal: AbortSignal) => {
      signals.push(signal);
      return answers.at(signals.length - 1) ?? false;
    },
    signals,
  };
};

describe("desktop bridge watch", () => {
  test("resolves on the first answer and stops probing", async () => {
    const { calls, probe } = scriptedProbe([false, false, true, true]);

    expect(
      await watchForDesktopBridge({
        intervalMs: 1,
        probe,
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("probes immediately, so an app already running links without a wait", async () => {
    const { calls, probe } = scriptedProbe([true]);

    expect(
      await watchForDesktopBridge({
        // An interval this long would outlive the test if the watch waited
        // before its first probe.
        intervalMs: 600_000,
        probe,
        signal: new AbortController().signal,
        timeoutMs: 600_000,
      }),
    ).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("hands the caller's signal to the probe so a request can be cancelled", async () => {
    const controller = new AbortController();
    const { probe, signals } = scriptedProbe([true]);

    await watchForDesktopBridge({
      intervalMs: 1,
      probe,
      signal: controller.signal,
      timeoutMs: 10,
    });

    expect(signals.at(0)).toBe(controller.signal);
  });

  test("gives up when the window closes, however slow the probes were", async () => {
    const { calls, probe } = scriptedProbe([]);
    // A probe that burns 400ms of a 1s window: the wall clock ends the watch
    // after three of them, where an attempt budget would have allowed ten.
    let clock = 0;
    const slowProbe = async (signal: AbortSignal) => {
      const answer = await probe(signal);
      clock += 400;
      return answer;
    };

    expect(
      await watchForDesktopBridge({
        intervalMs: 1,
        now: () => clock,
        probe: slowProbe,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
    ).toBe(false);
    expect(calls.length).toBe(3);
  });

  test("stops mid-interval when the caller aborts", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const probe = async () => {
      calls.push(calls.length);
      controller.abort();
      return false;
    };

    expect(
      await watchForDesktopBridge({
        // Two attempts, so the first probe is followed by a wait the abort
        // has to cut short; otherwise this test hangs.
        intervalMs: 600_000,
        probe,
        signal: controller.signal,
        timeoutMs: 1_200_000,
      }),
    ).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("stops when the caller aborts while the watch waits", async () => {
    const controller = new AbortController();
    const { calls, probe } = scriptedProbe([]);
    setTimeout(() => controller.abort(), 5);

    expect(
      await watchForDesktopBridge({
        // The abort arrives during the wait; without the listener the watch
        // would outlive this test.
        intervalMs: 600_000,
        probe,
        signal: controller.signal,
        timeoutMs: 1_200_000,
      }),
    ).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("never probes when the caller aborts before the watch starts", async () => {
    const { calls, probe } = scriptedProbe([true]);
    const controller = new AbortController();
    controller.abort();

    expect(
      await watchForDesktopBridge({
        intervalMs: 1,
        probe,
        signal: controller.signal,
        timeoutMs: 10,
      }),
    ).toBe(false);
    expect(calls.length).toBe(0);
  });
});
