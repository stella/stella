import { describe, expect, test } from "bun:test";

import {
  advanceToolCallTiming,
  createToolCallTiming,
} from "@/components/chat/tool-call-timing.logic";

describe("tool-call timing", () => {
  test("freezes the elapsed time when a running call finishes", () => {
    const running = createToolCallTiming({
      durationMs: undefined,
      isRunning: true,
      now: 1000,
    });
    const finished = advanceToolCallTiming({
      current: running,
      durationMs: undefined,
      isRunning: false,
      now: 3450,
    });

    expect(finished).toEqual({ status: "finished", durationMs: 2450 });
    expect(
      advanceToolCallTiming({
        current: finished,
        durationMs: undefined,
        isRunning: false,
        now: 9000,
      }),
    ).toBe(finished);
  });

  test("uses a known duration for an already-finished call", () => {
    expect(
      createToolCallTiming({
        durationMs: 8000,
        isRunning: false,
        now: 20_000,
      }),
    ).toEqual({ status: "finished", durationMs: 8000 });
  });

  test("replaces an estimated duration when the precise duration arrives", () => {
    expect(
      advanceToolCallTiming({
        current: { status: "finished", durationMs: 2450 },
        durationMs: 2312,
        isRunning: false,
        now: 9000,
      }),
    ).toEqual({ status: "finished", durationMs: 2312 });
  });
});
