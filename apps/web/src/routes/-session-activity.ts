import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { transformUnknownError } from "@/lib/errors/client";

export const SESSION_ACTIVITY_INTERVAL_MS = 15 * 60 * 1000;

export const isSessionActivityCancelled = (
  error: unknown,
  signal: AbortSignal,
) =>
  signal.aborted ||
  (typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError");

type SessionActivityOptions = {
  page: Pick<Document, "visibilityState" | "hasFocus">;
  observe: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

export const createSessionActivity = ({
  page,
  observe,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: SessionActivityOptions) => {
  const controller = new AbortController();
  let lastObservationAt = now();
  let inFlight = false;
  return {
    tick: async () => {
      if (
        controller.signal.aborted ||
        inFlight ||
        page.visibilityState !== "visible" ||
        !page.hasFocus() ||
        now() - lastObservationAt < SESSION_ACTIVITY_INTERVAL_MS
      ) {
        return;
      }
      lastObservationAt = now();
      inFlight = true;
      const observed = await Result.tryPromise({
        try: async () => await observe(controller.signal),
        catch: (cause) => cause,
      });
      inFlight = false;
      if (
        Result.isError(observed) &&
        !isSessionActivityCancelled(observed.error, controller.signal)
      ) {
        await Promise.reject(transformUnknownError(observed.error));
      }
    },
    dispose: () => controller.abort(),
  };
};
