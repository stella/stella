import { Temporal } from "@stll/time";

export const SESSION_ACTIVITY_INTERVAL_MS = 15 * 60 * 1000;

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
      await observe(controller.signal).finally(() => {
        inFlight = false;
      });
    },
    dispose: () => controller.abort(),
  };
};
