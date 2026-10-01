import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ClientUnknownError } from "@/lib/errors/client";
import {
  createSessionActivity,
  isSessionActivityCancelled,
  SESSION_ACTIVITY_INTERVAL_MS,
} from "@/routes/-session-activity";

describe("session activity observation", () => {
  test("turns unexpected non-Error rejections into a tagged client error", async () => {
    let now = 0;
    const unexpected = Promise.withResolvers<undefined>();
    const activity = createSessionActivity({
      page: { visibilityState: "visible", hasFocus: () => true },
      now: () => now,
      observe: async () => await unexpected.promise,
    });
    now = SESSION_ACTIVITY_INTERVAL_MS;
    const pending = Result.tryPromise({
      try: async () => await activity.tick(),
      catch: (cause) => cause,
    });
    unexpected.reject("unexpected rejection");
    const outcome = await pending;
    expect(Result.isError(outcome)).toBe(true);
    if (Result.isError(outcome)) {
      expect(outcome.error).toBeInstanceOf(ClientUnknownError);
      expect(outcome.error).toMatchObject({ message: "unexpected rejection" });
    }
    activity.dispose();
  });

  test("ignores an SDK error result after disposal without classifying real errors as cancellation", () => {
    const controller = new AbortController();
    const error = { status: 500, message: "Request failed" };
    expect(isSessionActivityCancelled(error, controller.signal)).toBe(false);
    expect(
      isSessionActivityCancelled({ name: "AbortError" }, controller.signal),
    ).toBe(true);
    controller.abort();
    expect(isSessionActivityCancelled(error, controller.signal)).toBe(true);
  });

  test.each(["abort", "dispose", "failure"] as const)(
    "handles rejected heartbeat requests on %s",
    async (mode) => {
      let now = 0;
      let rejectRequest: ((error: unknown) => void) | undefined;
      const activity = createSessionActivity({
        page: { visibilityState: "visible", hasFocus: () => true },
        now: () => now,
        observe: async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      });
      now = SESSION_ACTIVITY_INTERVAL_MS;
      const pending = activity.tick();
      const outcome = Result.tryPromise({
        try: async () => await pending,
        catch: (cause) => cause,
      });
      if (mode === "dispose") {
        activity.dispose();
      }
      const error =
        mode === "abort"
          ? new DOMException("Request aborted", "AbortError")
          : new TypeError("Network unavailable");
      rejectRequest?.(error);
      const observed = await outcome;
      expect(Result.isError(observed)).toBe(mode === "failure");
      if (Result.isError(observed)) {
        expect(observed.error).toBe(error);
      }
      activity.dispose();
    },
  );

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
