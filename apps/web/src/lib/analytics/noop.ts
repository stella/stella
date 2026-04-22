import { CancelledError } from "@tanstack/react-query";

import type { Analytics } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

// eslint-disable-next-line no-empty-function
const noop = () => {};

export const noopAnalytics: Analytics = {
  capture: noop,
  captureError: (error) => {
    if (error instanceof CancelledError) {
      return;
    }
    logDevError(error);
  },
};
