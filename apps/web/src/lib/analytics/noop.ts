import { CancelledError } from "@tanstack/react-query";
import { panic } from "better-result";

import type { Analytics, ErrorCaptureContext } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const noop = () => undefined;
const noopAsync = async () => {
  await Promise.resolve();
};

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
      context satisfies never;
      return panic(`Unhandled context: ${String(context)}`);
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
  captureRouteErrorLifecycle: noopAsync,
  identifyUser: noop,
  reset: noop,
};
