import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { waitForExternalState } from "./external-state.ts";
import { rejectionOf } from "./rejection.ts";

describe("waitForExternalState", () => {
  test("returns the first read that holds", async () => {
    const reads = [undefined, null, false, "ready", "later"];
    const state = await waitForExternalState({
      description: "the fixture state",
      read: () => reads.shift(),
      intervalMs: 0,
    });
    expect(state).toBe("ready");
    expect(reads).toEqual(["later"]);
  });

  test("awaits asynchronous reads", async () => {
    let calls = 0;
    const state = await waitForExternalState({
      description: "the third read",
      read: async () => {
        calls += 1;
        return await Promise.resolve(calls === 3);
      },
      intervalMs: 0,
    });
    expect(state).toBe(true);
    expect(calls).toBe(3);
  });

  test("fails with the description once the budget is spent", async () => {
    let calls = 0;
    const failure = await rejectionOf(
      waitForExternalState({
        description: "backend 42 waits on a lock",
        read: () => {
          calls += 1;
          return false;
        },
        intervalMs: 0,
        timeoutMs: 0,
      }),
    );
    expect(failure).toBeInstanceOf(Panic);
    expect(String(failure)).toContain("backend 42 waits on a lock");
    expect(calls).toBe(1);
  });

  test("returns the fallback once the budget is spent when one is given", async () => {
    const state = await waitForExternalState({
      description: "a state that never holds",
      read: () => false,
      intervalMs: 0,
      timeoutMs: 0,
      onTimeout: () => "gave up" as const,
    });
    expect(state).toBe("gave up");
  });
});
