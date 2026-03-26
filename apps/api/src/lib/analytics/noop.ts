import type { Analytics } from "@/api/lib/analytics/types";

// eslint-disable-next-line no-empty-function
const noop = () => {};
// eslint-disable-next-line no-empty-function
const asyncNoop = async () => {};

export const noopAnalytics: Analytics = {
  capture: noop,
  identify: noop,
  flush: asyncNoop,
};
