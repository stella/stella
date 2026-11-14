import { afterEach, describe, expect, jest, test } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import type { HarnessEvent } from "./events";
import { HarnessTurnLifecycle } from "./turn-lifecycle";

/** A harness process that exits as soon as it is asked to. */
const process = () => {
  const exited = Promise.resolve({ exitCode: 0, signal: null });
  return {
    exited,
    closeInput: () => undefined,
    kill: async () => await exited,
  };
};

/** A lifecycle whose turn's events are collected as they come. */
const lifecycleWith = (retryStallMs: number) => {
  const lifecycle = new HarnessTurnLifecycle<ReturnType<typeof process>>({
    gracePeriodMs: 10,
    detached: () => undefined,
    name: "test-turn",
    retryStallMs,
  });
  lifecycle.attach(process());
  const turn = lifecycle.turn({
    respond: () => {
      throw new Error("no interaction in this test");
    },
    steer: () => {
      throw new Error("no interaction in this test");
    },
    interrupt: async () => {
      await Promise.resolve();
    },
  });
  const events: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of turn.events) {
      events.push(event);
    }
  })();
  return { lifecycle, events, done };
};

afterEach(() => {
  restoreRealTimers();
});

describe("a turn whose harness keeps retrying the provider", () => {
  test("ends as stalled when nothing else happens for the window", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(30_000);
    lifecycle.emit({ type: "retrying", message: "Reconnecting" });
    jest.advanceTimersByTime(20_000);
    lifecycle.emit({ type: "retrying", message: "Reconnecting" });
    jest.advanceTimersByTime(10_000);
    await done;
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: {
        type: "retry_stalled",
        message: "The harness kept retrying the provider without progress.",
      },
    });
  });

  test("keeps going when the harness makes progress after a retry", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(30_000);
    lifecycle.emit({ type: "retrying", message: "Reconnecting" });
    lifecycle.emit({ type: "text.delta", messageId: "m", delta: "Back" });
    // Past the window, which the progress disarmed.
    jest.advanceTimersByTime(60_000);
    lifecycle.emit({ type: "turn.completed", usage: null });
    await done;
    expect(events.map(({ type }) => type)).toEqual([
      "retrying",
      "text.delta",
      "turn.completed",
    ]);
  });
});
