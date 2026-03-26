import type { Analytics } from "@/lib/analytics/types";

// eslint-disable-next-line no-empty-function
const noop = () => {};

export const noopAnalytics: Analytics = {
  capture: noop,
  captureError: (error) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  },
};
