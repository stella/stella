import { describe, expect, test } from "bun:test";

import {
  createSessionActivity,
  SESSION_ACTIVITY_INTERVAL_MS,
} from "@/routes/-session-activity";

describe("session activity observation", () => {
  test("observes only visible focused pages, at most every fifteen minutes", async () => {
    for (const visibilityState of ["visible", "hidden"] as const) {
      for (const focused of [true, false]) {
        let now = 0;
        let observations = 0;
        const activity = createSessionActivity({
          page: { visibilityState, hasFocus: () => focused },
          now: () => now,
          observe: async () => {
            observations += 1;
          },
        });
        await activity.tick();
        expect(observations).toBe(0);
        now = SESSION_ACTIVITY_INTERVAL_MS - 1;
        await activity.tick();
        expect(observations).toBe(0);
        now += 1;
        await activity.tick();
        expect(observations).toBe(
          visibilityState === "visible" && focused ? 1 : 0,
        );
        await activity.tick();
        expect(observations).toBe(
          visibilityState === "visible" && focused ? 1 : 0,
        );
        activity.dispose();
        now += SESSION_ACTIVITY_INTERVAL_MS;
        await activity.tick();
        expect(observations).toBe(
          visibilityState === "visible" && focused ? 1 : 0,
        );
      }
    }
  });

  test("coalesces focus and timer observations and aborts on frame disposal", async () => {
    let now = 0;
    let observedSignal: AbortSignal | undefined;
    let complete: (() => void) | undefined;
    let observations = 0;
    const activity = createSessionActivity({
      page: { visibilityState: "visible", hasFocus: () => true },
      now: () => now,
      observe: async (signal) => {
        observations += 1;
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      },
    });
    now += SESSION_ACTIVITY_INTERVAL_MS;
    const pending = activity.tick();
    now += SESSION_ACTIVITY_INTERVAL_MS;
    await activity.tick();
    expect(observations).toBe(1);
    activity.dispose();
    expect(observedSignal?.aborted).toBe(true);
    complete?.();
    await pending;
    await activity.tick();
    expect(observations).toBe(1);
  });
});
