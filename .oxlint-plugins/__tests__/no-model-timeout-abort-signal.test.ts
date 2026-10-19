import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-model-timeout-abort-signal", () => {
  test("reports direct and combined timeout abort signals", async () => {
    expect(
      await lintSingleRule(
        "no-model-timeout-abort-signal",
        "generateTanStackTextForTask({ abortSignal: AbortSignal.timeout(1000) });\ngenerateTanStackObjectForTask({ abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(1000)]) });",
      ),
    ).toEqual([1, 2]);
  });

  test("accepts caller cancellation alongside an owned deadline", async () => {
    expect(
      await lintSingleRule(
        "no-model-timeout-abort-signal",
        "generateTanStackObjectForTask({ abortSignal: request.signal, deadlineMs: 1000 });",
      ),
    ).toEqual([]);
  });

  test("judges each call by its own abortSignal, not a neighbour's", async () => {
    expect(
      await lintSingleRule(
        "no-model-timeout-abort-signal",
        "generateTanStackTextForTask({ abortSignal: AbortSignal.timeout(1000) });\ngenerateTanStackObjectForTask({ abortSignal: request.signal, deadlineMs: 1000 });",
      ),
    ).toEqual([1]);
  });
});
