import { CancelledError } from "@tanstack/react-query";

import type { Analytics, ErrorCaptureContext } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const noop = () => undefined;

const devErrorContext = (
  context: ErrorCaptureContext | undefined,
): Record<string, string> | undefined => {
  if (!context) {
    return undefined;
  }

  switch (context.type) {
    case "detached":
      return { detached: context.operation };
    case "recovery":
      return { error_reference: context.reference };
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
};

export const noopAnalytics: Analytics = {
  captureError: (error, context) => {
    if (error instanceof CancelledError) {
      return;
    }
    logDevError(error, devErrorContext(context));
  },
  capturePageViewed: noop,
  captureGuideStepSkipped: noop,
  identifyUser: noop,
  reset: noop,
};
