import { CancelledError } from "@tanstack/react-query";

import type { Analytics } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const noop = () => undefined;

export const noopAnalytics: Analytics = {
  captureError: (error, context) => {
    if (error instanceof CancelledError) {
      return;
    }
    logDevError(error, context);
  },
  capturePageViewed: noop,
  identifyUser: noop,
  reset: noop,
};
