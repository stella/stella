import { afterEach, describe, expect, jest, test } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import { type HarnessEvent, harnessSessionId } from "./events";
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
const lifecycleWith = (retryStallMs: number, silenceMs?: number) => {
  const lifecycle = new HarnessTurnLifecycle<ReturnType<typeof process>>({
    gracePeriodMs: 10,
    detached: () => undefined,
    name: "test-turn",
    retryStallMs,
    ...(silenceMs === undefined ? {} : { silenceMs }),
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

const RETRY: HarnessEvent = {
  type: "notice",
  notice: { kind: "retrying", attempt: 1, maxAttempts: 5 },
};

describe("a turn whose harness keeps retrying the provider", () => {
  test("ends as stalled when nothing else happens for the window", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(30_000);
    lifecycle.emit(RETRY);
    jest.advanceTimersByTime(20_000);
    lifecycle.emit(RETRY);
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
    lifecycle.emit(RETRY);
    lifecycle.emit({ type: "text.delta", messageId: "m", delta: "Back" });
    // Past the window, which the progress disarmed.
    jest.advanceTimersByTime(60_000);
    lifecycle.emit({ type: "turn.completed", usage: null, boundary: null });
    await done;
    expect(events.map(({ type }) => type)).toEqual([
      "notice",
      "text.delta",
      "turn.completed",
    ]);
  });

  test("a config warning during a retry is no progress, and no retry of its own", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(30_000);
    lifecycle.emit(RETRY);
    jest.advanceTimersByTime(20_000);
    lifecycle.emit({ type: "notice", notice: { kind: "config_warning" } });
    jest.advanceTimersByTime(10_000);
    await done;
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      failure: { type: "retry_stalled" },
    });
  });

  test("a config warning alone arms no retry window", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(30_000);
    lifecycle.emit({ type: "notice", notice: { kind: "config_warning" } });
    jest.advanceTimersByTime(40_000);
    lifecycle.emit({ type: "turn.completed", usage: null, boundary: null });
    await done;
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
});

const SILENCE_MS = 60_000;

const UNANSWERED = {
  type: "turn.failed",
  failure: {
    type: "request_unanswered",
    message:
      "The model provider did not answer for too long. The connection or a proxy in front of it may be down.",
  },
} as const;

const toolCall = { id: "call-1", name: "Bash", input: {} };

describe("a turn whose model request goes unanswered", () => {
  test("ends as unanswered once the harness is silent for the window", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      10 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.emit({
      type: "session.started",
      sessionId: harnessSessionId("session-1"),
      continuation: { type: "fresh" },
    });
    jest.advanceTimersByTime(SILENCE_MS);
    await done;
    expect(events.at(-1)).toEqual(UNANSWERED);
  });

  test("keeps going while the harness writes anything", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      10 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.heard();
    for (let step = 0; step < 5; step += 1) {
      jest.advanceTimersByTime(SILENCE_MS - 1);
      lifecycle.heard();
    }
    lifecycle.emit({ type: "turn.completed", usage: null, boundary: null });
    jest.advanceTimersByTime(10 * SILENCE_MS);
    await done;
    expect(events.map(({ type }) => type)).toEqual(["turn.completed"]);
  });

  test("never counts the time a tool runs, and counts again once it ends", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      10 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.emit({ type: "tool.started", toolCall });
    jest.advanceTimersByTime(5 * SILENCE_MS);
    lifecycle.emit({
      type: "tool.completed",
      toolCall,
      result: { status: "succeeded", content: "" },
    });
    jest.advanceTimersByTime(SILENCE_MS);
    await done;
    // Silence while the tool ran would have ended the turn before its result.
    expect(events.map(({ type }) => type)).toEqual([
      "tool.started",
      "tool.completed",
      "turn.failed",
    ]);
    expect(events.at(-1)).toEqual(UNANSWERED);
  });

  test("never counts the time an approval waits on the member", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      10 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.emit({
      type: "approval.requested",
      request: {
        requestId: "approval-1",
        kind: "command",
        toolCall,
        reason: null,
        options: [],
      },
    });
    jest.advanceTimersByTime(5 * SILENCE_MS);
    lifecycle.emit({ type: "interaction.resolved", requestId: "approval-1" });
    lifecycle.emit({ type: "turn.completed", usage: null, boundary: null });
    await done;
    expect(events.map(({ type }) => type)).toEqual([
      "approval.requested",
      "interaction.resolved",
      "turn.completed",
    ]);
  });

  test("leaves a retrying harness to the retry window", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      3 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.heard();
    lifecycle.emit(RETRY);
    jest.advanceTimersByTime(3 * SILENCE_MS);
    await done;
    // The retry window, longer than the silence one, ended the turn.
    expect(events.map(({ type }) => type)).toEqual(["notice", "turn.failed"]);
    expect(events.at(-1)).toMatchObject({
      failure: { type: "retry_stalled" },
    });
  });

  test("a stop in progress ends the turn as interrupted, not unanswered", async () => {
    jest.useFakeTimers();
    const { lifecycle, events, done } = lifecycleWith(
      10 * SILENCE_MS,
      SILENCE_MS,
    );
    lifecycle.heard();
    const stopping = lifecycle.interrupt(async () => {
      await Promise.resolve();
      return true;
    });
    jest.advanceTimersByTime(2 * SILENCE_MS);
    lifecycle.exited({ exitCode: null, signal: "SIGTERM" });
    await stopping;
    await done;
    expect(events.map(({ type }) => type)).toEqual(["turn.interrupted"]);
  });
});
