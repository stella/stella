import { CancelledError } from "@tanstack/react-query";

import { reportUnownedCaughtError } from "@/lib/analytics/reported-error";
import type { Analytics } from "@/lib/analytics/types";

/** The root's fallback for errors caught by a boundary that reports nothing. */
export const createRootCaughtErrorHandler =
  (readAnalytics: () => Pick<Analytics, "captureError">) =>
  (error: unknown): void => {
    // CancelledError is benign: React Query throws it during route transitions
    // when a suspended query unmounts.
    if (error instanceof CancelledError) {
      return;
    }
    reportUnownedCaughtError(error, (caughtError) => {
      readAnalytics().captureError(caughtError, {
        fingerprintKey: "hydrate:onCaughtError",
        scope: { type: "handler", handlerId: "hydrate:onCaughtError" },
      });
    });
  };
